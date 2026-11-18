---
hcanvas: notebook
version: 1
title: Maxwell–Bloch
kernel: python
variables: {"omega0":2,"detuning":0,"T1":8,"T2":4,"w_eq":-1,"kappa":0.35}
---

# Maxwell–Bloch: a two-level medium under a light pulse

This notebook follows a short Gaussian optical pulse through a homogeneously broadened two-level medium. The Bloch vector $(u,v,w)$ describes the atomic coherence and inversion, while the Rabi frequency $\Omega$ is the slowly varying optical field.

The first code cells solve the local optical Bloch equations. The last simulation adds one-dimensional propagation, so the pulse and the medium evolve together.

Change a value in the **Variables** panel, then run the cells again. The Python, C++ and Octave cells all read the same shared parameters.

## Optical Bloch equations

For a two-level atom with detuning $\Delta=\omega-\omega_0$, coherence time $T_2$, population relaxation time $T_1$, and equilibrium inversion $w_{eq}$:

$$
\begin{aligned}
\dot u &= \Delta v - u/T_2,\\
\dot v &= -\Delta u + \Omega w - v/T_2,\\
\dot w &= -\Omega v - (w-w_{eq})/T_1.
\end{aligned}
$$

Here $u$ and $v$ are the in-phase and quadrature components of the coherence, and $w=\rho_{22}-\rho_{11}$ is the inversion. The pulse is switched on smoothly at $t=0$, so the medium starts in its equilibrium state.

| parameter | meaning | initial value |
| --- | --- | --- |
| omega0 | peak Rabi frequency | 2.0 |
| detuning | atom–field detuning | 0.0 |
| T1 | population relaxation | 8.0 |
| T2 | coherence dephasing | 4.0 |
| w_eq | equilibrium inversion | -1.0 |

The first Python cell integrates the equations with fourth-order Runge–Kutta and plots the inversion and coherence.

```python exec
import matplotlib
matplotlib.use("Agg")
import numpy as np
import matplotlib.pyplot as plt

omega0 = float(hc_get("omega0", 2.0))
detuning = float(hc_get("detuning", 0.0))
T1 = float(hc_get("T1", 8.0))
T2 = float(hc_get("T2", 4.0))
w_eq = float(hc_get("w_eq", -1.0))

dt = 0.01
t = np.arange(0.0, 60.0 + dt, dt)
drive = omega0 * np.exp(-0.5 * ((t - 12.0) / 4.0) ** 2)

def rhs(u, v, w, field):
    return (
        detuning * v - u / T2,
        -detuning * u + field * w - v / T2,
        -field * v - (w - w_eq) / T1,
    )

u = np.zeros_like(t)
v = np.zeros_like(t)
w = np.full_like(t, w_eq)
for i in range(len(t) - 1):
    field = drive[i]
    k1u, k1v, k1w = rhs(u[i], v[i], w[i], field)
    k2u, k2v, k2w = rhs(u[i] + 0.5*dt*k1u, v[i] + 0.5*dt*k1v, w[i] + 0.5*dt*k1w, field)
    k3u, k3v, k3w = rhs(u[i] + 0.5*dt*k2u, v[i] + 0.5*dt*k2v, w[i] + 0.5*dt*k2w, field)
    k4u, k4v, k4w = rhs(u[i] + dt*k3u, v[i] + dt*k3v, w[i] + dt*k3w, field)
    u[i+1] = u[i] + dt * (k1u + 2*k2u + 2*k3u + k4u) / 6.0
    v[i+1] = v[i] + dt * (k1v + 2*k2v + 2*k3v + k4v) / 6.0
    w[i+1] = w[i] + dt * (k1w + 2*k2w + 2*k3w + k4w) / 6.0

peak_inversion = float(np.max(w))
final_inversion = float(w[-1])
hc_set("peak_inversion", peak_inversion)
hc_set("final_inversion", final_inversion)

fig, axes = plt.subplots(2, 1, figsize=(9, 5.6), sharex=True)
axes[0].plot(t, drive, color="#6d5bd0", lw=2)
axes[0].set_ylabel("Rabi frequency")
axes[0].set_title("Gaussian pulse")
axes[0].grid(alpha=0.25)
axes[1].plot(t, w, color="#b45309", lw=2, label="inversion w")
axes[1].plot(t, u, color="#047857", lw=1.3, label="coherence u")
axes[1].plot(t, v, color="#2563eb", lw=1.3, label="coherence v")
axes[1].axhline(w_eq, color="#8a8276", ls="--", lw=1, label="w_eq")
axes[1].set_xlabel("time")
axes[1].set_ylabel("Bloch components")
axes[1].legend(frameon=False, ncol=2)
axes[1].grid(alpha=0.25)
fig.suptitle("Rabi flopping of a two-level medium", fontsize=13)
fig.tight_layout()

print("peak inversion:", round(peak_inversion, 4))
print("final inversion:", round(final_inversion, 4))
```

```python exec
import matplotlib
matplotlib.use("Agg")
import numpy as np
import matplotlib.pyplot as plt

omega0 = float(hc_get("omega0", 2.0))
T1 = float(hc_get("T1", 8.0))
T2 = float(hc_get("T2", 4.0))
w_eq = float(hc_get("w_eq", -1.0))

dt = 0.01
t = np.arange(0.0, 25.0 + dt, dt)
drive = omega0 * np.exp(-0.5 * ((t - 10.0) / 4.0) ** 2)
detunings = np.linspace(-4.0, 4.0, 81)

u = np.zeros_like(detunings)
v = np.zeros_like(detunings)
w = np.full_like(detunings, w_eq)
for field in drive[:-1]:
    du = detunings * v - u / T2
    dv = -detunings * u + field * w - v / T2
    dw = -field * v - (w - w_eq) / T1
    u += dt * du
    v += dt * dv
    w += dt * dw

inversion_curve = w.copy()
hc_set("scan_min_inversion", float(np.min(inversion_curve)))
hc_set("scan_max_inversion", float(np.max(inversion_curve)))

fig, ax = plt.subplots(figsize=(8, 4.2))
ax.plot(detunings, inversion_curve, color="#7c3aed", lw=2)
ax.fill_between(detunings, w_eq, inversion_curve, color="#ede9fe", alpha=0.7)
ax.axhline(w_eq, color="#8a8276", ls="--", lw=1)
ax.set_xlabel("detuning Delta")
ax.set_ylabel("inversion after pulse")
ax.set_title("Inversion left after the pulse")
ax.grid(alpha=0.25)
fig.tight_layout()

print("minimum post-pulse inversion:", round(float(np.min(inversion_curve)), 4))
print("maximum post-pulse inversion:", round(float(np.max(inversion_curve)), 4))
```

## Adding one dimension of propagation

A local Bloch model does not yet move the light. In a one-dimensional, slowly varying envelope approximation, the field and medium are coupled by a one-way Maxwell equation:

$$
\partial_t \Omega + c\,\partial_z \Omega = -\kappa v.
$$

The medium still follows the Bloch equations at every position. The numerical grid below uses dimensionless units, with the pulse entering at $z=0$ and $c\,dt/dz<1$ for stable upwind propagation.

The simulation stores a space–time map of the field and the final inversion profile. This is a simplified model: it ignores diffraction, transverse effects, and the full wave equation, but it captures the essential Maxwell–Bloch coupling.

```python exec
import matplotlib
matplotlib.use("Agg")
import numpy as np
import matplotlib.pyplot as plt

omega0 = float(hc_get("omega0", 2.0))
detuning = float(hc_get("detuning", 0.0))
T1 = float(hc_get("T1", 8.0))
T2 = float(hc_get("T2", 4.0))
w_eq = float(hc_get("w_eq", -1.0))
kappa = float(hc_get("kappa", 0.35))

L = 10.0
nz = 201
dz = L / (nz - 1)
c = 1.0
dt = 0.01
duration = 36.0
steps = int(duration / dt)
z = np.linspace(0.0, L, nz)

field = np.zeros(nz)
u = np.zeros(nz)
v = np.zeros(nz)
w = np.full(nz, w_eq)

history = []
times = []

def boundary(t):
    return omega0 * np.exp(-0.5 * ((t - 7.0) / 1.5) ** 2)

snapshot_every = 20
for step in range(steps):
    now = step * dt
    local_field = field.copy()

    du = detuning * v - u / T2
    dv = -detuning * u + local_field * w - v / T2
    dw = -local_field * v - (w - w_eq) / T1
    u = u + dt * du
    v = v + dt * dv
    w = w + dt * dw

    next_field = field.copy()
    next_field[0] = boundary(now + dt)
    next_field[1:] = field[1:] - (c * dt / dz) * (field[1:] - field[:-1]) - kappa * dt * v[1:]
    field = next_field

    if step % snapshot_every == 0:
        history.append(field.copy())
        times.append(now)

history = np.array(history)
times = np.array(times)
hc_set("propagation_peak_field", float(np.max(history)))
hc_set("propagation_final_inversion", float(w[-1]))

fig, axes = plt.subplots(2, 1, figsize=(9, 6.2), gridspec_kw={"height_ratios": [2, 1]})
image = axes[0].imshow(
    history.T,
    origin="lower",
    aspect="auto",
    extent=[times[0], times[-1], 0.0, L],
    cmap="magma",
    vmin=0.0,
    vmax=float(np.max(history)) or 1.0,
)
axes[0].set_xlabel("time")
axes[0].set_ylabel("position z")
axes[0].set_title("propagating Rabi field Omega(z,t)")
fig.colorbar(image, ax=axes[0], shrink=0.85, label="Omega")

axes[1].plot(z, w, color="#b45309", lw=2)
axes[1].axhline(w_eq, color="#8a8276", ls="--", lw=1)
axes[1].set_xlabel("position z")
axes[1].set_ylabel("final inversion")
axes[1].set_title("inversion left behind the pulse")
axes[1].grid(alpha=0.25)
fig.tight_layout()

print("peak field:", round(float(np.max(history)), 4))
print("final inversion range:", round(float(np.min(w)), 4), "to", round(float(np.max(w)), 4))
```

## Cross-language check

The C++ and Octave cells use the same variables as Python. They publish their derived Rabi period back to the shared Variables panel. Run them after the first Python cell to see values flow between kernels.

```cpp exec
const double omega0_cpp = hc_get("omega0", 2.0);
const double t1_cpp = hc_get("T1", 8.0);
const double pi_cpp = std::acos(-1.0);
const double rabi_period_cpp = 2.0 * pi_cpp / omega0_cpp;
hc_set("rabi_period_cpp", rabi_period_cpp);
std::cout << "C++ cross-check: Rabi period = " << rabi_period_cpp
          << ", T1 = " << t1_cpp << std::endl;
```

```octave exec
omega0_oct = hc_get("omega0", 2.0);
T1_oct = hc_get("T1", 8.0);
rabi_period_oct = 2 * pi / omega0_oct;
hc_set("rabi_period_octave", rabi_period_oct);
fprintf("Octave cross-check: Rabi period = %.4f, T1 = %.4f\n", rabi_period_oct, T1_oct);
```

## What to try

1. Change **omega0** to 1.0 or 3.0 in the Variables panel, then rerun the first two Python cells and compare the flopping frequency and the resonance width.
2. Change **detuning** to 0.5. The final inversion should no longer sit at the center of the resonance curve.
3. Run the propagation cell with **kappa** set to 0.0 and then 0.8. The first case is a pure optical Bloch model; the second shows the field being modified by the medium.
4. Run the C++ and Octave cells. They read the same shared parameters and publish their derived Rabi period back to the Variables panel.

A useful check: the area of a short pulse controls how far the Bloch vector travels, while $T_1$ and $T_2$ determine how quickly the medium forgets the excitation. The space–time map in the propagation cell shows where the pulse has already interacted with the medium.
