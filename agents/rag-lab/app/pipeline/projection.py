from __future__ import annotations

import numpy as np


class PCA3D:
    """Deterministic PCA to 3D: sign-pinned, bbox-normalised."""

    def __init__(self) -> None:
        self.mean_: np.ndarray | None = None
        self.components_: np.ndarray | None = None   # (3, dim)
        self.explained_variance_ratio_: list[float] = []

    def fit(self, X: np.ndarray) -> "PCA3D":
        """Fit on corpus embeddings (N, dim)."""
        self.mean_ = X.mean(axis=0)
        Xc = X - self.mean_
        # Economy SVD — cheaper than full
        _, s, Vt = np.linalg.svd(Xc, full_matrices=False)
        # Keep top-3 right singular vectors
        components = Vt[:3]
        # Sign-pin: largest-magnitude loading per PC must be positive
        for i in range(len(components)):
            idx = np.argmax(np.abs(components[i]))
            if components[i][idx] < 0:
                components[i] = -components[i]

        # Guarantee exactly 3 components even when N or dim < 3 (tiny docs),
        # so transform() always yields (N, 3) and the 3D renderer never gets NaN.
        dim = X.shape[1]
        if components.shape[0] < 3:
            pad = np.zeros((3 - components.shape[0], dim), dtype=components.dtype)
            components = np.vstack([components, pad])

        self.components_ = components
        total_var = float((s ** 2).sum()) or 1.0
        ratios = [float((s[k] ** 2) / total_var) for k in range(min(3, len(s)))]
        ratios += [0.0] * (3 - len(ratios))
        self.explained_variance_ratio_ = ratios
        return self

    def transform(self, X: np.ndarray) -> np.ndarray:
        """Project (N, dim) → (N, 3), bbox-normalised to [-1, 1]."""
        if self.mean_ is None or self.components_ is None:
            raise RuntimeError("PCA3D not fitted")
        Xc = X - self.mean_
        projected = Xc @ self.components_.T  # (N, 3)
        return _bbox_normalise(projected)

    def fit_transform(self, X: np.ndarray) -> np.ndarray:
        return self.fit(X).transform(X)


def _bbox_normalise(pts: np.ndarray) -> np.ndarray:
    """Scale each axis to [-1, 1] using the bounding box of the corpus."""
    lo = pts.min(axis=0)
    hi = pts.max(axis=0)
    span = hi - lo
    span[span == 0] = 1.0  # avoid divide-by-zero for degenerate axes
    return 2 * (pts - lo) / span - 1
