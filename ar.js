// ar.js — camera -> AprilTag detection -> pose -> three.js render, every frame.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { poseFromCorners, poseToThreeMatrix } from './pose.js';
import { MODELS } from './models.js';

// ---------------------------------------------------------------- config (URL params override: ?model=bird&fov=70&id=3)
const q = new URLSearchParams(location.search);
const CFG = {
  family: 'APRILTAG_36h11',
  onlyId: q.has('id') ? +q.get('id') : null, // null = any tag in the family
  procLongSide: 640,                          // detection resolution (px on the long side). Lower = faster, jitterier
  fovLongDeg: +(q.get('fov') ?? 65),          // camera FOV across the image's long side. Phone main cams ≈ 60–70°
  smoothing: 0.5,                             // 0 = raw (jittery), 0.9 = very laggy
  lostAfterMs: 400,                           // keep showing the model this long after the tag drops out
};

// ---------------------------------------------------------------- DOM
const $ = (id) => document.getElementById(id);
const video = $('cam'), stage = $('stage'), status = $('status');
const proc = document.createElement('canvas');                     // downscaled frame for the detector
const pctx = proc.getContext('2d', { willReadFrequently: true });
const detector = new AR.Detector({ dictionaryName: CFG.family, maxHammingDistance: 4 });

// ---------------------------------------------------------------- three.js scene, all in camera space
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture; // reflections for brass
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);      // stays at the origin, looking down -z
const headlight = new THREE.DirectionalLight(0xffffff, 0.7);        // fill from the phone, so the side facing you is never black
headlight.position.set(0.3, 0.5, 1); scene.add(headlight);

const anchor = new THREE.Group();                                  // = the tag. 1 unit = black square's edge
anchor.matrixAutoUpdate = true; anchor.visible = false;
scene.add(anchor);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, 3, 2); anchor.add(sun);                        // light fixed to the tag, not the phone
anchor.add(contactShadow());
const holder = new THREE.Group(); anchor.add(holder);

function contactShadow() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.002;
  return m;
}

// ---------------------------------------------------------------- models
let active = null, mixer = null;
function setModel(name) {
  if (active) holder.remove(active.root);
  mixer = null;
  active = MODELS[name]();
  holder.add(active.root);
  document.querySelectorAll('[data-model]').forEach((b) => b.classList.toggle('on', b.dataset.model === name));
}
async function loadGLB(file) {
  const gltf = await new GLTFLoader().parseAsync(await file.arrayBuffer(), '');
  const obj = gltf.scene, box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  obj.position.set(-ctr.x, -box.min.y, -ctr.z);                  // stand it on the tag, centred
  const root = new THREE.Group(); root.add(obj);
  root.scale.setScalar(1.2 / Math.max(size.x, size.y, size.z));  // fit ~1.2 tag widths
  if (active) holder.remove(active.root);
  active = { root, update() {} };
  holder.add(root);
  mixer = new THREE.AnimationMixer(obj);
  gltf.animations.forEach((clip) => mixer.clipAction(clip).play());
  document.querySelectorAll('[data-model]').forEach((b) => b.classList.remove('on'));
  status.textContent = `loaded ${file.name} · ${gltf.animations.length} animation(s)`;
}

// ---------------------------------------------------------------- layout: video "cover"s the screen, canvas matches it exactly
let vw = 0, vh = 0, pw = 0, ph = 0, f = 1;
function layout() {
  vw = video.videoWidth; vh = video.videoHeight;
  const k = CFG.procLongSide / Math.max(vw, vh);
  pw = proc.width = Math.round(vw * k); ph = proc.height = Math.round(vh * k);
  // Pinhole model in detector pixels. Same f drives the pose AND the render camera, so they agree.
  f = (Math.max(pw, ph) / 2) / Math.tan(THREE.MathUtils.degToRad(CFG.fovLongDeg) / 2);
  camera.aspect = pw / ph;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(ph / 2 / f));
  camera.updateProjectionMatrix();
  const s = Math.max(innerWidth / vw, innerHeight / vh);
  const W = Math.round(vw * s), H = Math.round(vh * s);
  stage.style.width = W + 'px'; stage.style.height = H + 'px';
  renderer.setSize(W, H, false);
}
addEventListener('resize', () => vw && layout());

// ---------------------------------------------------------------- per-frame
const M = new THREE.Matrix4(), tp = new THREE.Vector3(), tq = new THREE.Quaternion(), ts = new THREE.Vector3();
const camWorld = new THREE.Vector3(0, 0, 0);
let lastSeen = -1e9, lastT = 0, fps = 0;

function pick(markers) {
  if (CFG.onlyId != null) return markers.find((m) => m.id === CFG.onlyId);
  const area = (c) => Math.abs((c[2].x - c[0].x) * (c[3].y - c[1].y) - (c[3].x - c[1].x) * (c[2].y - c[0].y));
  return markers.sort((a, b) => area(b.corners) - area(a.corners))[0]; // biggest = closest
}

function frame(now) {
  requestAnimationFrame(frame);
  const t = now / 1000, dt = Math.min(0.1, t - lastT); lastT = t;
  fps = fps * 0.95 + (dt > 0 ? 1 / dt : 0) * 0.05;

  if (video.readyState >= 2 && video.videoWidth) {
    if (video.videoWidth !== vw || video.videoHeight !== vh) layout(); // rotation / first frame
    pctx.drawImage(video, 0, 0, pw, ph);
    const m = pick(detector.detect(pctx.getImageData(0, 0, pw, ph)));
    if (m) {
      M.fromArray(poseToThreeMatrix(poseFromCorners(m.corners, f, pw / 2, ph / 2)));
      M.decompose(tp, tq, ts);
      if (!anchor.visible) { anchor.position.copy(tp); anchor.quaternion.copy(tq); } // snap on (re)acquire
      else { anchor.position.lerp(tp, 1 - CFG.smoothing); anchor.quaternion.slerp(tq, 1 - CFG.smoothing); }
      anchor.visible = true; lastSeen = now;
      status.textContent = `tag ${m.id} · ${tp.length().toFixed(1)} tag-widths away · ${fps.toFixed(0)} fps`;
    } else if (now - lastSeen > CFG.lostAfterMs) {
      anchor.visible = false;
      status.textContent = `looking for a tag36h11… · ${fps.toFixed(0)} fps`;
    }
  }
  scene.updateMatrixWorld();
  if (anchor.visible && active) active.update(t, dt, camWorld);
  if (mixer) mixer.update(dt);
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- UI wiring
async function start() {
  $('start').hidden = true;
  if (!window.isSecureContext) { status.textContent = 'Camera needs HTTPS (or localhost).'; return; }
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    await video.play();
    requestAnimationFrame(frame);
  } catch (e) { status.textContent = 'Camera error: ' + e.message; $('start').hidden = false; }
}
$('start').onclick = start;
document.querySelectorAll('[data-model]').forEach((b) => (b.onclick = () => setModel(b.dataset.model)));
$('glb').onchange = (e) => e.target.files[0] && loadGLB(e.target.files[0]).catch((err) => (status.textContent = 'GLB error: ' + err.message));
$('fov').value = CFG.fovLongDeg; $('fovv').textContent = CFG.fovLongDeg + '°';
$('fov').oninput = (e) => { CFG.fovLongDeg = +e.target.value; $('fovv').textContent = e.target.value + '°'; if (vw) layout(); };
$('showtag').onclick = () => { $('tagsvg').innerHTML = detector.dictionary.generateSVG(CFG.onlyId ?? 0); $('tagview').hidden = false; };
$('tagview').onclick = () => ($('tagview').hidden = true);
setModel(MODELS[q.get('model')] ? q.get('model') : 'cat');
if (q.has('autostart')) start();
