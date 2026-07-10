---
title: "Firecracker microVM Snapshot-Restore: Eliminating Serverless Cold Starts at Microsecond Granularity"
date: 2026-07-10
tags: ["firecracker", "microvm", "serverless", "snapshot-restore", "virtualization"]
excerpt: "How Firecracker's snapshot-restore mechanism uses memory-mapped dirty page tracking and incremental state serialization to achieve sub-5ms function restore times, enabling near-zero cold starts for serverless workloads at scale."
---

# Firecracker microVM Snapshot-Restore: Eliminating Serverless Cold Starts at Microsecond Granularity

Serverless cold starts have been the bane of latency-sensitive FaaS workloads since inception. A typical cold start involves: provisioning a sandbox, loading a runtime, initializing application state, and establishing network connectivity. For a Python function with moderate dependencies, this easily reaches 500ms to 2s. Firecracker, the open-source VMM built on KVM, attacks this problem at the hypervisor level through a snapshot-restore mechanism that can resume a fully-initialized microVM in under 5ms.

## The Architecture of a Firecracker Snapshot

A Firecracker snapshot consists of two artifacts:

1. **vmstate**: A serialized representation of all vCPU registers, device model state (virtio-net, virtio-block, serial, vsock), interrupt controller state (APIC/IOAPIC), and KVM internal structures.
2. **guest memory file**: A raw dump of the guest's physical address space at snapshot time.

The key insight is that these artifacts represent a *post-initialization* checkpoint. The guest OS has already booted, the runtime has loaded, the application has imported dependencies, and connections are primed. Restore skips the entire initialization path.

```rust
// Simplified Firecracker snapshot creation flow
pub fn create_snapshot(
    vm: &Vm,
    vmstate_path: &Path,
    mem_path: &Path,
) -> Result<(), SnapshotError> {
    // 1. Pause all vCPUs
    vm.pause_vcpus()?;
    
    // 2. Serialize device state via Versionize trait
    let mut snapshot_data = Snapshot::new(SNAPSHOT_VERSION);
    vm.mmio_device_manager.save_state(&mut snapshot_data)?;
    vm.vcpus.iter().try_for_each(|vcpu| {
        vcpu.save_state(&mut snapshot_data)
    })?;
    
    // 3. Dump guest memory (mmap'd region -> file)
    vm.guest_memory.dump_to_file(mem_path)?;
    
    // 4. Write serialized state
    snapshot_data.write_to_file(vmstate_path)?;
    Ok(())
}
```

## Restore: The Critical Path

The restore path is where Firecracker achieves its sub-5ms latency. The sequence is:

1. **Memory mapping** (not loading): The guest memory file is `mmap`'d with `MAP_PRIVATE`, making it copy-on-write. No actual page reads occur until the guest touches memory.
2. **KVM VM creation**: A single `ioctl(KVM_CREATE_VM)` allocates kernel structures.
3. **Memory region registration**: `KVM_SET_USER_MEMORY_REGION` tells KVM where the mmap'd guest memory lives. This is O(1) per memory slot.
4. **vCPU state restoration**: Register files, MSRs, and FPU state are injected via `KVM_SET_REGS`, `KVM_SET_SREGS`, `KVM_SET_MSRS`.
5. **Device state restoration**: Virtio queues, interrupt routing, and device-specific state are deserialized.
6. **Resume**: vCPUs begin executing from their saved instruction pointers.

```c
// The critical mmap that avoids copying guest memory
void *guest_mem = mmap(
    NULL,
    guest_mem_size,
    PROT_READ | PROT_WRITE,
    MAP_PRIVATE | MAP_NORESERVE,  // CoW semantics
    mem_file_fd,
    0
);
// Only pages the guest actually touches get faulted in
// from the backing file. Working set << total memory.
```

The demand-paging behavior is critical: a function with 512MB of allocated memory might only touch 20MB during a typical invocation. The remaining 492MB never gets read from the snapshot file.

## Dirty Page Tracking for Incremental Snapshots

For frequently-snapshotted VMs (e.g., after each function invocation to capture warm state), dumping the entire memory every time is prohibitive. Firecracker leverages KVM's dirty page tracking:

```rust
// Enable dirty page logging for a memory region
let dirty_log = kvm_dirty_log {
    slot: memory_slot_id,
    padding1: 0,
    dirty_bitmap: bitmap_ptr as *mut c_void,
};

// After enabling, KVM tracks which pages the guest modifies
ioctl(vm_fd, KVM_GET_DIRTY_LOG, &dirty_log)?;

// Only write dirty pages to the diff snapshot
for page_idx in dirty_bitmap.iter_ones() {
    let offset = page_idx * PAGE_SIZE;
    diff_file.write_at(
        &guest_memory[offset..offset + PAGE_SIZE],
        offset as u64,
    )?;
}
```

This produces *diff snapshots* that are typically 1-10MB for a warmed-up function, compared to the full 128-512MB base snapshot. Restore applies the base snapshot first, then overlays diffs in order, a technique analogous to overlay filesystems.

## The Memory Balloon and UFFD Integration

Modern Firecracker deployments combine snapshots with two additional mechanisms:

### Userfaultfd (UFFD) for Lazy Restore

Instead of relying solely on kernel demand paging from the mmap'd file, production systems use `userfaultfd` to intercept page faults in userspace. This enables:

- **Prioritized page loading**: Pages for hot code paths are pre-fetched while cold pages remain unloaded.
- **Network-backed restore**: The memory file can reside on remote storage; UFFD handlers fetch pages over the network on demand.
- **Telemetry**: Each page fault is observable, enabling working-set profiling.

```c
// Register userfaultfd for the guest memory region
struct uffdio_register reg = {
    .range = { .start = (uint64_t)guest_mem, .len = guest_mem_size },
    .mode = UFFDIO_REGISTER_MODE_MISSING,
};
ioctl(uffd, UFFDIO_REGISTER, &reg);

// Handler thread resolves faults by copying from snapshot
void *handle_fault(void *arg) {
    struct uffd_msg msg;
    while (read(uffd, &msg, sizeof(msg)) > 0) {
        uint64_t fault_addr = msg.arg.pagefault.address;
        uint64_t offset = fault_addr - (uint64_t)guest_mem;
        
        // Read page from snapshot file (or network)
        pread(snapshot_fd, page_buf, PAGE_SIZE, offset);
        
        struct uffdio_copy copy = {
            .dst = fault_addr & ~(PAGE_SIZE - 1),
            .src = (uint64_t)page_buf,
            .len = PAGE_SIZE,
        };
        ioctl(uffd, UFFDIO_COPY, &copy);
    }
}
```

### Memory Balloon for Density

The virtio-balloon device allows the host to reclaim unused guest memory. After snapshot-restore, pages that the guest has freed (but are still mapped from the snapshot) can be reclaimed:

1. Guest inflates balloon, returning pages to the host.
2. Host `madvise(MADV_DONTNEED)` on those pages, freeing physical memory.
3. Effective memory footprint approaches actual working set, not allocated size.

This enables packing 3-5x more dormant function instances on a single host.

## Performance Characteristics

Empirical measurements from the open-source Firecracker benchmarks reveal:

| Operation | Time | Notes |
|-----------|------|-------|
| Full snapshot creation (256MB) | ~40ms | Dominated by memory dump I/O |
| Diff snapshot creation | 2-8ms | Proportional to dirty pages |
| Restore from snapshot | 3-5ms | mmap + state deserialization |
| Time to first guest instruction | <6ms | Including KVM setup |
| Page fault latency (local SSD) | ~4μs | Per demand-paged 4KB page |
| Page fault latency (network) | 50-200μs | UFFD + remote fetch |

The critical metric is *time-to-first-request*: how quickly the restored function can handle incoming traffic. With working-set pre-fetching (loading the ~50 most-accessed pages during restore), this drops below 10ms for typical functions.

## Snapshot Versioning and Live Migration

Firecracker's `Versionize` derive macro generates backward-compatible serialization for device state:

```rust
#[derive(Versionize)]
pub struct VirtioNetState {
    pub rx_queue: QueueState,
    pub tx_queue: QueueState,
    pub config_space: Vec<u8>,
    #[version(start = 2)]  // Added in snapshot version 2
    pub mq_enabled: bool,
}
```

This allows restoring snapshots taken by older Firecracker versions on newer ones, enabling rolling upgrades of the VMM without invalidating pre-warmed snapshot pools. The version negotiation happens at deserialize time: missing fields get defaults, unknown fields are skipped.

## Implications for System Design

The snapshot-restore primitive changes serverless architecture in fundamental ways:

**Pre-warming pools**: Instead of keeping idle VMs running, maintain a pool of snapshot files on NVMe. Restore is cheaper than keeping a VM warm (zero CPU, zero memory while dormant).

**Function specialization**: Take snapshots *after* the first request (when JIT has compiled hot paths, connection pools are established, caches are primed). Subsequent invocations restore into this optimized state.

**Deterministic replay**: Snapshots represent exact machine state. Combined with recorded network inputs, this enables deterministic replay for debugging production issues.

**Multi-tenant density**: With UFFD lazy loading and balloon deflation, thousands of pre-snapshotted function instances can coexist on a single host, each consuming only working-set memory until activated.

The combination of KVM hardware virtualization (for isolation), demand-paged memory restore (for speed), dirty tracking (for incremental snapshots), and userfaultfd (for flexible page management) represents a systems engineering tour de force, turning what was once a multi-second penalty into a sub-10ms operation indistinguishable from a warm invocation.
