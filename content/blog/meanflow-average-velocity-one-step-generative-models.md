---
title: "Average Velocity: How MeanFlow Collapses Sampling to One Step"
date: 2026-08-21
tags: [generative-models, diffusion, machine-learning, numerical-methods, optimization]
excerpt: "Flow matching learns instantaneous velocity, so sampling needs an ODE solver and dozens of network calls. MeanFlow learns average velocity instead and closes the loop with a differential identity trainable by a single JVP, reaching FID 3.43 at one function evaluation. I derived the gradient-variance law behind its two strangest hyperparameters and measured it: the noise amplification factor is exactly the flow-map Jacobian, and on bimodal data 1% of samples carry 91% of the variance."
---

Flow matching gives you a beautiful training objective and an annoying sampling procedure. You regress a network on the instantaneous velocity `v(z_t, t)`, which is cheap and stable, and then at inference you have to *integrate* that velocity field, which costs 50 to 250 network evaluations. Every trick for cutting that down, consistency models, progressive distillation, shortcut models, has historically involved either a teacher model, a curriculum, or a bootstrapping scheme that makes training fragile.

"Mean Flows for One-step Generative Modeling" (Geng, Deng, Bai, Kolter, He, arXiv:2505.13447) does it with one change of variable and one derivative. Train the network on *average* velocity rather than instantaneous velocity, and sampling becomes a single subtraction. From scratch, no distillation, no pre-training: FID 3.43 on ImageNet 256x256 at 1 network evaluation, against 10.60 for the previous best one-step model (Shortcut-XL/2) and 34.24 for iCT-XL/2.

I reimplemented the core identity analytically, verified it to 1e-9, and then derived and measured the gradient-variance law that explains the paper's two most arbitrary-looking hyperparameters.

## The change of variable

Use the standard interpolation `z_t = (1-t)x + t*eps` with data at `t=0` and noise at `t=1`, so the conditional velocity is `v_t = eps - x`. Flow matching regresses on that. MeanFlow instead defines, for a time interval `[r, t]`,

```
u(z_t, r, t) = 1/(t-r) * integral from r to t of v(z_tau, tau) d_tau
```

This is the displacement over the interval divided by the interval length. It is a property of the velocity field, not of any network. Two things fall out immediately. As `r -> t` it converges to `v`, so average velocity generalizes instantaneous velocity. And the exact sampling rule is `z_r = z_t - (t-r) * u(z_t, r, t)`, which for `r=0, t=1` is one call:

```
x = eps - u(eps, r=0, t=1)
```

No solver, no discretization error, because `u` already contains the integral.

The problem is that the definition is not a training target. You cannot regress on an integral you do not have. The fix is to differentiate it. Multiply through and differentiate in `t` with `r` held fixed, using the product rule on the left and the fundamental theorem of calculus on the right:

```
d/dt [ (t-r) * u(z_t, r, t) ] = v(z_t, t)
u + (t-r) * du/dt = v
```

which rearranges to the **MeanFlow Identity**:

```
u(z_t, r, t) = v(z_t, t) - (t-r) * du/dt
```

where `du/dt` is the total derivative along the trajectory. Since `dz_t/dt = v` and `dr/dt = 0`, it expands to `v * d_z u + d_t u`. That is a Jacobian-vector product of `u` with tangent `(v, 0, 1)` on inputs `(z, r, t)`, which forward-mode autodiff computes in a single pass, and which only propagates to inputs rather than to parameters, so it is cheaper than a parameter backward pass. The reported wall-clock overhead in JAX is 16%, 0.052 s/iter against 0.045 s/iter for flow matching.

The whole training algorithm, from the paper (CC BY 4.0):

```python
t, r = sample_t_r()
e = randn_like(x)
z = (1 - t) * x + t * e
v = e - x
u, dudt = jvp(fn, (z, r, t), (v, 0, 1))
u_tgt = v - (t - r) * dudt
loss = metric(u - stopgrad(u_tgt))
```

Note what is *not* there: no teacher, no EMA target network, no discretization schedule. The stop-gradient on the target is what avoids double backpropagation through the JVP. And when `r = t` the second term vanishes and this is literally flow matching, which is the escape hatch that makes the whole thing trainable from random initialization.

## The part nobody explains

Two hyperparameters in the paper look like folklore. First, only 25% of samples get `r != t`; the other 75% are plain flow matching. Second, the loss is not `L2` but the adaptive form `w = 1/(||delta||^2 + c)^p` with `p = 1`, and the ablation is brutal: 1-NFE FID goes 79.75 at `p=0`, 63.98 at `p=0.5`, 61.06 at `p=1`. Setting `r != t` on 100% of samples costs 6 FID points; setting it on 0% diverges to 328.

Both are variance control, and you can see exactly why by writing the target out. The subtlety is that `v_t = eps - x` in the pseudocode is the *conditional* velocity of one sample, not the marginal field, and it appears twice: once as the leading term and once as the JVP tangent. Because it enters linearly in both places, collect it:

```
u_tgt = (1 - (t-r) * d_z u) * v_t  -  (t-r) * d_t u
```

The target is still conditionally unbiased, linearity saves you there. But the noise in `v_t`, which is the same noise flow matching lives with, arrives multiplied by the scalar `1 - (t-r) * d_z u`. And that factor has an identity of its own. Differentiating the sampling rule `z_r = z_t - (t-r) u` in `z_t` gives

```
1 - (t-r) * d_z u  =  d z_r / d z_t  =  J
```

**the Jacobian of the flow map from `t` to `r`.** So the conditional covariance of the MeanFlow target is the flow-matching covariance conjugated by the flow map:

```
Cov(u_tgt | z_t) = J * Cov(v_t | z_t) * J^T
```

MeanFlow inherits flow matching's gradient noise, pushed through the transport it is trying to learn. Where transport contracts, MeanFlow is *quieter* than flow matching. Where it expands, MeanFlow is louder by the square.

For 1-D Gaussian data this is exact and closed form. The marginals are `N((1-t)*mu, s(t)^2)` with `s(t)^2 = (1-t)^2*sigma^2 + t^2`, the probability-flow map is the monotone rearrangement, and `J = s(r)/s(t)`. Checking all of it numerically over 20,000 random `(z, r, t)`:

```
MeanFlow identity residual:        max 1.18e-09   rms 8.48e-11
1-(t-r)*d_z u  vs  d z_r/d z_t:    max 1.75e-10
d z_r / d z_t  vs  s(r)/s(t):      max 4.31e-10

Monte-Carlo, 400k posterior draws per cell:
  r=0.0 t=0.5   J=1.414   sd(v_t)=1.416   sd(u_tgt)=2.002   predicted 2.002
  r=0.5 t=1.0   J=0.707   sd(v_t)=1.000   sd(u_tgt)=0.707   predicted 0.707
  r=0.0 t=1.0   J=1.000   sd(v_t)=0.999   sd(u_tgt)=0.999   predicted 0.999
```

Residuals are at the finite-difference floor, and the variance law is exact to four digits.

## Where it detonates

Gaussian data is the benign case, `J` stays inside `[0.7, 1.4]`. Real data is multimodal, and a flow map that has to *decide* which mode a noise sample belongs to is exponentially expanding at the boundary. Take `x` as two modes at `+/-2.0` with width 0.25, compute the exact marginal velocity for the mixture, and integrate the probability-flow ODE with RK4 to get `J` directly:

```
  (r,t)     z_t/sd     |J|        J^2
  (0.0,1.0)   0.00   10560.8   1.1e+08     <- the separatrix
  (0.0,1.0)   0.25       0.70       0.5
  (0.0,1.0)   1.00       0.34       0.1
  (0.3,1.0)   0.00     971.0   9.4e+05
  (0.6,1.0)   0.00       1.44       2.1
```

`z = 0` is an unstable fixed point of the flow, the point that is equidistant from both modes, and trajectories near it diverge. Sampling `z_t` from the real marginal and `r < t` uniformly, 20,000 draws:

```
  p50   |J| =   0.80    J^2 =      0.6
  p90   |J| =   1.07    J^2 =      1.1
  p99   |J| =   3.89    J^2 =     15.2
  p99.9 |J| =  31.99    J^2 =   1023.5
  max   |J| = 281.33    J^2 =  79145.6
  mean J^2 = 8.9   (flow matching = 1.0 by definition)
  top 1% of samples carry 91.1% of total gradient-variance mass
```

The median is *below* one, MeanFlow really is quieter than flow matching for the typical sample. The mean is 8.9x worse, and it is worse entirely because of a 1% tail. That is the signature of a heavy-tailed estimator, and it is precisely the failure mode that a normalizing loss fixes. Plugging the measured `J` distribution into the paper's adaptive weight:

```
  p=0.0  ->  mean effective variance multiplier  8.92
  p=0.5  ->                                      0.95
  p=1.0  ->                                      1.00
  top-1% share of mass after p=1: 1.0%   (was 91.1%)
```

`p=1` makes the per-sample gradient magnitude invariant to `||delta||`, which caps the separatrix samples at the same weight as everything else and drops the tail's share of the variance from 91% to 1%. And the 75% of samples drawn with `r = t` have `J = 1` exactly, by construction, so three quarters of every batch is guaranteed-tame flow matching. The two folklore hyperparameters are the same fix applied twice.

## What 2026 did with it

The follow-up literature converged on the same diagnosis from other directions. "On Variance Reduction in Learning Mean Flows" (arXiv:2605.09235) attributes the instability to the conditional velocity acting as a mis-weighted control variate, which is the same `J`-conjugation seen from the estimator side. "Stabilizing, Scaling & Enhancing MeanFlow" (arXiv:2605.17834) adds a discrete-solution warm-up to get 12B to 80B distillation to converge, and SubFlow (arXiv:2604.12273) names the mode-boundary problem "averaging distortion" and conditions on sub-modes to sidestep it, which is exactly the separatrix above. Beyond images, the identity has been ported to Lie groups for protein backbones, to CTMC kernels for discrete state spaces, to PDE operators, and to one-step RL policies where 85 ms of action-generation latency becomes 60 ms.

Practical reading if you are considering this: budget the JVP at roughly 15 to 20% wall clock, never ship plain `L2`, keep a majority of your batch at `r = t`, and if training blows up, look at where your flow map has to make categorical decisions rather than at your learning rate. The variance is not uniformly distributed over `(z, r, t)`, it is concentrated on a measure-zero set that your sampler keeps hitting.
