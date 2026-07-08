---
title: "Learned Cardinality Estimation: When Neural Networks Replace Histograms in Query Optimizers"
date: 2026-07-09
tags: ["databases", "query-optimization", "machine-learning", "cardinality-estimation", "systems"]
excerpt: "How modern database systems replace decades-old histogram-based cardinality estimators with neural models — covering CardBench, MSCN, and NeuroCard architectures that reduce join order estimation errors from 1000x to under 3x."
---

# Learned Cardinality Estimation: When Neural Networks Replace Histograms in Query Optimizers

Every database query optimizer faces the same fundamental problem: to pick the best join order and access path, it must estimate how many rows will flow through each operator in the plan tree. Get this estimate wrong by 10x and your query takes seconds instead of milliseconds. Get it wrong by 1000x and your OLAP query never finishes.

Traditional estimators — histograms, most-common-values lists, and the independence assumption — have remained largely unchanged since System R in 1979. They systematically fail on correlated columns, complex predicates, and multi-way joins. Google's **CardBench** benchmark (VLDB 2024) measured estimation errors across 20 real-world datasets and found that PostgreSQL's estimator produces median errors of 100-1000x on queries with 3+ joins.

Learned cardinality estimation replaces these statistical heuristics with neural models trained on the actual data distribution — and the results are dramatic.

## Why Traditional Estimators Fail

The core issue is the **attribute value independence (AVI) assumption**. Traditional estimators compute the selectivity of `WHERE city = 'NYC' AND state = 'NY'` as the product of individual selectivities — treating `city` and `state` as independent when they are perfectly correlated.

For joins, the problem compounds. The **uniformity assumption** (every value in the join column is equally likely to match) and **inclusion assumption** (every value in the smaller relation appears in the larger) produce estimates that diverge exponentially with join depth:

```
Actual cardinality:     |R ⋈ S ⋈ T| = 1,200
Histogram estimate:     |R ⋈ S ⋈ T| = 4,500,000
Error factor:           3,750x
```

This isn't a pathological case. It's the median scenario for TPC-H Query 9 variants.

## Architecture 1: Multi-Set Convolutional Networks (MSCN)

Kipf et al. (CIDR 2019) introduced **MSCN**, the first practical learned estimator that handles joins. The key insight: represent a query as three sets — tables, joins, and predicates — then use set-convolution to produce a cardinality estimate.

The architecture encodes each query as:

```
Query Encoding:
  Tables:     [one-hot(t1), one-hot(t2), ..., one-hot(tn)]
  Joins:      [one-hot(t1.a = t2.b), ..., one-hot(ti.x = tj.y)]
  Predicates: [embed(t1.col op val), ..., embed(tk.col op val)]
```

Each set passes through an independent MLP, pooled via average, then concatenated and fed through a final MLP that outputs `log(cardinality)`:

```python
class MSCN(nn.Module):
    def __init__(self, table_dim, join_dim, pred_dim, hidden=256):
        self.table_mlp = nn.Sequential(
            nn.Linear(table_dim, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden)
        )
        self.join_mlp = nn.Sequential(
            nn.Linear(join_dim, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden)
        )
        self.pred_mlp = nn.Sequential(
            nn.Linear(pred_dim, hidden), nn.ReLU(),
            nn.Linear(hidden, hidden)
        )
        self.final = nn.Sequential(
            nn.Linear(hidden * 3, hidden), nn.ReLU(),
            nn.Linear(hidden, 1)
        )

    def forward(self, tables, joins, preds):
        t = self.table_mlp(tables).mean(dim=1)
        j = self.join_mlp(joins).mean(dim=1)
        p = self.pred_mlp(preds).mean(dim=1)
        return self.final(torch.cat([t, j, p], dim=-1))
```

MSCN achieves median q-error of 3-5x on the IMDb JOB benchmark — a 50x improvement over PostgreSQL. But it requires executing thousands of training queries to collect ground-truth cardinalities, making it expensive to bootstrap.

## Architecture 2: NeuroCard — Autoregressive Data Models

Yang et al. (VLDB 2021) took a fundamentally different approach with **NeuroCard**: instead of learning query-to-cardinality mappings, learn the full joint data distribution using an autoregressive model. Then answer any cardinality query by computing the probability under that distribution.

The model factorizes the joint distribution of all columns across all joined tables:

```
P(col_1, col_2, ..., col_n) = ∏ P(col_i | col_1, ..., col_{i-1})
```

This is implemented as a **MADE** (Masked Autoregressive Density Estimator) network with variable ordering. For a query `SELECT * FROM R JOIN S ON R.a = S.b WHERE R.x > 5`:

1. Encode the join constraint `R.a = S.b` as a shared variable
2. Compute `P(R.x > 5, R.a = S.b)` using progressive sampling
3. Multiply by the domain sizes to get the cardinality

The critical advantage: NeuroCard needs zero query execution for training. It trains purely on the data, then answers arbitrary queries at inference time. On IMDb JOB, it achieves median q-error below 2x — approaching the theoretical optimum.

## CardBench: Benchmarking at Scale (VLDB 2024)

Google's **CardBench** provided the first rigorous, large-scale comparison across 20 real datasets (not just IMDb). Key findings:

1. **PostgreSQL** median q-error: 100-10,000x depending on join count
2. **MSCN** median q-error: 3-8x (trained per workload)
3. **NeuroCard** median q-error: 1.5-3x (trained per schema)
4. **Zero-shot transformers** (pretrained on multiple schemas): 5-15x

The zero-shot finding is particularly interesting. CardBench trained a transformer on cardinality estimation across multiple schemas, then evaluated on unseen schemas. The model learns transferable patterns about data distributions — a step toward universal cardinality estimators.

## Integration: The Bao Approach

Knowing the cardinality isn't enough — you need to convince the optimizer to use it. Marcus et al. (SIGMOD 2021) proposed **Bao** (Bandit optimizer), which doesn't replace the cardinality estimator but instead learns which optimizer *hints* produce better plans:

```sql
-- Bao selects from optimizer hint configurations:
-- Config A: HashJoin(orders, lineitem), SeqScan(lineitem)  
-- Config B: MergeJoin(orders, lineitem), IndexScan(lineitem)
-- Config C: Default optimizer plan

-- Bao's tree-CNN scores each plan tree and picks the best
SELECT /*+ Bao(config=A) */ ... FROM orders JOIN lineitem ...
```

This "steering" approach avoids the integration nightmare of replacing the estimator internals. It works as a wrapper around any existing optimizer and can be deployed incrementally.

## Production Challenges

Deploying learned estimators in production systems raises unsolved problems:

**Data drift.** When the underlying data changes (inserts, deletes, updates), the model's distribution estimate becomes stale. Retraining on every write is infeasible. Current approaches use incremental updates: detect distribution shift via KL-divergence monitoring and retrain only affected model components.

**Tail latency.** Model inference adds 0.1-1ms per subquery estimate. For OLTP queries with simple plans, this overhead dominates. Production systems use a hybrid: invoke the neural estimator only for queries with 2+ joins where traditional estimators are known to fail.

**Regression safety.** A learned model can catastrophically underestimate, choosing a nested-loop join for a billion-row table. Systems like Bao include a **fallback guard**: if the learned plan's estimated cost exceeds the default plan's cost by more than 100x, fall back to the default.

```python
def select_plan(query, learned_model, default_optimizer):
    default_plan = default_optimizer.optimize(query)
    learned_plan = learned_model.suggest_plan(query)
    
    if learned_plan.estimated_cost > 100 * default_plan.estimated_cost:
        return default_plan  # safety fallback
    
    return learned_plan
```

## Where This Is Heading

The convergence point is clear: foundation models for database systems. Google's zero-shot results in CardBench show that a model pretrained on diverse schemas can estimate cardinalities on unseen databases with reasonable accuracy. Combine this with:

- **Workload-aware fine-tuning** for production deployment
- **Uncertainty quantification** to know when to fall back
- **Online learning** from query execution feedback

The PostgreSQL community is actively exploring integration paths. The `pg_learned` extension prototype (2025) hooks into the planner's `estimate_num_groups` and `clausesel.c` paths to substitute neural estimates for traditional ones.

Within 5 years, the histogram-based estimator that has powered every major RDBMS since 1979 will become a fallback — the reliable but conservative default that kicks in only when the learned model signals low confidence. The query optimizer, that most brittle and heuristic-laden component of any database system, is about to become data-driven.

## References

- Kipf et al., "Learned Cardinalities: Estimating Correlated Joins with Deep Learning," CIDR 2019
- Yang et al., "NeuroCard: One Cardinality Estimator for All Tables," VLDB 2021
- Marcus et al., "Bao: Making Learned Query Optimization Practical," SIGMOD 2021
- Negi et al., "CardBench: A Benchmark for Learned Cardinality Estimation in Relational Databases," VLDB 2024
