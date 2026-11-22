// pose.js — 4 tag corners (pixels) -> camera-space pose. No dependencies.
//
// Pipeline:  corners --DLT--> homography H --K^-1--> [r1 r2 t] --orthonormalise--> R, t
//
// Conventions
//   Image / OpenCV camera:  x right, y down, z forward (into the scene).
//   Tag frame (as printed):  X right, Y down the page, Z into the paper. Units: the BLACK
//                            square's edge = 1, so its corners sit at (±0.5, ±0.5).
//   three.js camera:        x right, y up, z backward (camera looks down -z).
//   three.js object on tag:  y = out of the paper (up), x = tag right, z = toward tag's bottom edge.

// js-aruco2 returns the corners clockwise, starting at the tag's top-left (canonical orientation),
// so these are the matching tag-plane points.
export const TAG_CORNERS = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];

// Solve A x = b (n×n) by Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const k = A[r][c] / A[c][c];
      for (let j = c; j < n; j++) A[r][j] -= k * A[c][j];
      b[r] -= k * b[c];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let j = r + 1; j < n; j++) s -= A[r][j] * x[j];
    x[r] = s / A[r][r];
  }
  return x;
}

// Homography (row-major, h22 = 1) mapping tag-plane (X,Y) -> image (u,v). Exactly 4 points: 8 equations, 8 unknowns.
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [X, Y] = src[i], [u, v] = dst[i];
    A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]); b.push(u);
    A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]); b.push(v);
  }
  return [...solve(A, b), 1];
}

const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a) => scale(a, 1 / norm(a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Camera intrinsics: focal length f (pixels), principal point (cx, cy). Square pixels, no distortion.
// Returns { r1, r2, r3, t } in OpenCV camera coordinates (columns of R, and translation).
export function poseFromCorners(corners, f, cx, cy) {
  const H = homography(TAG_CORNERS, corners.map((c) => [c.x, c.y]));
  // Column j of K^-1 H.  Ideally K^-1 H = λ [r1 r2 t].
  const col = (j) => [(H[j] - cx * H[6 + j]) / f, (H[3 + j] - cy * H[6 + j]) / f, H[6 + j]];
  const h1 = col(0), h2 = col(1), h3 = col(2);
  let s = 2 / (norm(h1) + norm(h2));       // 1/λ: r1, r2 must be unit length
  if (h3[2] < 0) s = -s;                     // sign ambiguity: the tag must be in front (t_z > 0)
  const r1 = scale(h1, s), r2 = scale(h2, s), t = scale(h3, s);
  // Noise makes r1, r2 slightly non-orthogonal. Symmetric fix: rotate both equally
  // about their bisector until they're 90° apart (cheaper than an SVD, same answer to 1st order).
  const a = unit(r1), b = unit(r2);
  const c = unit(add(a, b)), d = unit(sub(a, b));
  const R1 = scale(add(c, d), Math.SQRT1_2), R2 = scale(sub(c, d), Math.SQRT1_2);
  return { r1: R1, r2: R2, r3: cross(R1, R2), t };
}

// Convert to a three.js object matrix (column-major Float array of 16) in three's camera space.
//   object x  = tag X           -> R·(1,0,0)  = r1
//   object y  = -tag Z (up)     -> R·(0,0,-1) = -r3
//   object z  = tag Y           -> R·(0,1,0)  = r2
// then OpenCV->three camera flips y and z (diag(1,-1,-1)). Both maps are proper rotations: no mirroring.
export function poseToThreeMatrix({ r1, r2, r3, t }) {
  const X = [r1[0], -r1[1], -r1[2]];
  const Y = [-r3[0], r3[1], r3[2]];
  const Z = [r2[0], -r2[1], -r2[2]];
  const P = [t[0], -t[1], -t[2]];
  return [...X, 0, ...Y, 0, ...Z, 0, ...P, 1];
}
