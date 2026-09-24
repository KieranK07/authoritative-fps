import * as THREE from '/node_modules/three/build/three.module.js';

console.log('Client script loading...');

let socket = null;

const statusEl = document.getElementById('status');
const roundTimerEl = document.getElementById('roundTimer');
const weaponInfoEl = document.getElementById('weaponInfo');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const chatMessages = document.getElementById('chatMessages');
const healthFillEl = document.getElementById('healthFill');
const healthTextEl = document.getElementById('healthText');
const staminaFillEl = document.getElementById('staminaFill');
const staminaTextEl = document.getElementById('staminaText');
const hitMarkerEl = document.getElementById('hitMarker');
const killFeedEl = document.getElementById('killFeed');
const scoreRowsEl = document.getElementById('scoreRows');
const scoreboardEl = document.getElementById('scoreboard');
const deathScreenEl = document.getElementById('deathScreen');
const respawnCountdownEl = document.getElementById('respawnCountdown');
const weaponButtonsEl = document.getElementById('weaponButtons');
const loginOverlayEl = document.getElementById('loginOverlay');
const nameInputEl = document.getElementById('nameInput');
const guestBtnEl = document.getElementById('guestBtn');
const googleBtnEl = document.getElementById('googleBtn');
const loginHintEl = document.getElementById('loginHint');

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x7fb7ea, 45, 160);
const textureLoader = new THREE.TextureLoader();
textureLoader.setCrossOrigin('anonymous');
const cubeLoader = new THREE.CubeTextureLoader();
cubeLoader.setCrossOrigin('anonymous');

function configureTexture(texture, repeatX = 1, repeatY = 1) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  return texture;
}

// Procedural sky - starts as day blue, will be updated with sun position
scene.background = new THREE.Color(0x87ceeb);
scene.fog.color.copy(scene.background);

const floorTexture = configureTexture(
  textureLoader.load('https://threejs.org/examples/textures/terrain/grasslight-big.jpg'),
  16,
  16
);
const obstacleTextureBase = configureTexture(
  textureLoader.load('https://threejs.org/examples/textures/brick_diffuse.jpg'),
  2,
  2
);
const playerTextureBase = configureTexture(
  textureLoader.load('https://threejs.org/examples/textures/uv_grid_opengl.jpg'),
  2,
  3
);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 8, 14);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
renderer.domElement.style.filter = 'saturate(1.35) contrast(1.2) brightness(1.04) sepia(0.08) hue-rotate(-9deg)';

const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
floorTexture.anisotropy = maxAnisotropy;
obstacleTextureBase.anisotropy = maxAnisotropy;
playerTextureBase.anisotropy = maxAnisotropy;

const hemiLight = new THREE.HemisphereLight(0xb9d5ff, 0x1f0f09, 1.5);
scene.add(hemiLight);

// Create the sun as a visible sphere
const sunGeometry = new THREE.SphereGeometry(2, 32, 32);
const sunMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00, fog: false, toneMapped: false });
const sunMesh = new THREE.Mesh(sunGeometry, sunMaterial);
scene.add(sunMesh);

// Directional light that follows the sun
const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.near = 1;
dirLight.shadow.camera.far = 220;
dirLight.shadow.camera.left = -55;
dirLight.shadow.camera.right = 55;
dirLight.shadow.camera.top = 55;
dirLight.shadow.camera.bottom = -55;
dirLight.shadow.bias = -0.00025;
dirLight.shadow.normalBias = 0.03;
dirLight.target.position.set(0, 0, 0);
scene.add(dirLight.target);
scene.add(dirLight);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(120, 120),
  new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.95, metalness: 0.02 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(60, 60, 0x7fa5a8, 0x556a70);
grid.position.y = 0.01;
const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
for (const mat of gridMaterials) {
  mat.transparent = true;
  mat.opacity = 0.24;
}
scene.add(grid);

const input = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
};

let cameraYaw = 0;
let cameraPitch = 0;
const MAX_PITCH = Math.PI / 2.5;
const UP = new THREE.Vector3(0, 1, 0);
const moveForwardVec = new THREE.Vector3();
const moveRightVec = new THREE.Vector3();
const moveWorldVec = new THREE.Vector3();

let localId = null;
let latestSeq = 0;
let worldBounds = 30;
let maxHealth = 100;
let maxStamina = 100;
let localHealth = 100;
let localStamina = 100;
let localSprinting = false;
let localKills = 0;
let localDeaths = 0;
let localAlive = true;
let localAmmoMag = 30;
let localAmmoReserve = 90;
let localReloading = false;
let localWeaponName = 'Rifle';
let roundTimeLeft = 420;
let weaponFireInterval = 0.12;
let shootingHeld = false;
let nextShootAt = 0;
let hitMarkerUntil = 0;
let availableWeapons = [];
let selectedWeapon = 'rifle';
let respawnStartTime = 0;
let respawnDuration = 5;
const tracerMeshes = [];
const impactEffects = [];
const remotePlayers = new Map();
const obstacleMeshes = [];

function formatRoundTime(seconds) {
  const clamped = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function updateSunPosition(tod) {
  // Fixed daylight position
  const sunX = -40;
  const sunY = 50;
  const sunZ = -30;
  sunMesh.position.set(sunX, sunY, sunZ);
  dirLight.position.copy(sunMesh.position);
}

function updateSkyColor(tod) {
  // Fixed day colors
  dirLight.intensity = 1.8;
  hemiLight.intensity = 0.92;
  for (const mat of gridMaterials) {
    mat.opacity = 0.24;
  }
}


function clearObstacleMeshes() {
  while (obstacleMeshes.length > 0) {
    const mesh = obstacleMeshes.pop();
    scene.remove(mesh);
    mesh.geometry.dispose();
    if (mesh.material?.map) {
      mesh.material.map.dispose();
    }
    mesh.material.dispose();
  }
}

function buildMap(obstacles = []) {
  clearObstacleMeshes();

  for (const obstacle of obstacles) {
    const blockTex = obstacleTextureBase.clone();
    blockTex.repeat.set(Math.max(1, obstacle.w * 0.65), Math.max(1, obstacle.h * 0.65));
    blockTex.needsUpdate = true;

    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(obstacle.w, obstacle.h, obstacle.d),
      new THREE.MeshStandardMaterial({
        map: blockTex,
        color: new THREE.Color(obstacle.color || '#6c7a89'),
        roughness: 0.85,
        metalness: 0.08,
      })
    );

    mesh.position.set(obstacle.x, obstacle.h * 0.5, obstacle.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    obstacleMeshes.push(mesh);
  }
}

function createPlayerVisual(colorHex) {
  const group = new THREE.Group();
  const bodyTexture = playerTextureBase.clone();
  bodyTexture.repeat.set(2, 3);
  bodyTexture.needsUpdate = true;

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.45, 1.1, 6, 12),
    new THREE.MeshStandardMaterial({
      map: bodyTexture,
      color: new THREE.Color(colorHex),
      roughness: 0.7,
      metalness: 0.05,
    })
  );
  body.castShadow = true;
  // Keep rendered capsule centered on authoritative server position.
  body.position.y = 0;
  group.add(body);

  const tag = document.createElement('div');
  tag.className = 'card';
  tag.style.position = 'fixed';
  tag.style.padding = '2px 6px';
  tag.style.fontSize = '11px';
  tag.style.pointerEvents = 'none';
  tag.style.zIndex = '25';
  tag.style.transform = 'translate(-50%, -100%)';
  tag.textContent = 'Player';
  document.body.appendChild(tag);

  scene.add(group);

  return {
    group,
    body,
    tag,
    targetPosition: new THREE.Vector3(),
    targetYaw: 0,
  };
}


function destroyPlayerVisual(player) {
  scene.remove(player.group);
  player.group.traverse((obj) => {
    if (obj.geometry) {
      obj.geometry.dispose();
    }
    if (obj.material) {
      if (obj.material.map) {
        obj.material.map.dispose();
      }
      obj.material.dispose();
    }
  });
  player.tag.remove();
}

function addChatLine(msg) {
  const line = document.createElement('div');
  line.className = 'chatLine';

  if (msg.id === 'system') {
    line.classList.add('chatSystem');
    line.textContent = `[System] ${msg.text}`;
  } else {
    const name = document.createElement('span');
    name.className = 'chatName';
    name.textContent = `${msg.name}: `;

    const text = document.createElement('span');
    text.textContent = msg.text;

    line.appendChild(name);
    line.appendChild(text);
  }

  chatMessages.appendChild(line);

  while (chatMessages.children.length > 40) {
    chatMessages.removeChild(chatMessages.firstChild);
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addKillFeedItem(entry) {
  const line = document.createElement('div');
  line.className = 'killItem';
  const headshotText = entry.headshot ? ' <span class="killHead">HS</span>' : '';
  line.innerHTML = `${entry.killer} -> ${entry.victim}${headshotText}`;
  killFeedEl.prepend(line);

  while (killFeedEl.children.length > 8) {
    killFeedEl.removeChild(killFeedEl.lastChild);
  }
}

function updateScoreboard(playersObj = {}) {
  const list = Object.values(playersObj)
    .sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || a.name.localeCompare(b.name));

  scoreRowsEl.innerHTML = '';
  for (const player of list) {
    const row = document.createElement('div');
    row.className = 'scoreRow';
    const isMe = player.id === localId;
    row.innerHTML = `
      <span class="scoreName${isMe ? ' me' : ''}">${player.name}${player.alive ? '' : ' (DEAD)'}</span>
      <span>${player.kills ?? 0}</span>
      <span>${player.deaths ?? 0}</span>
    `;
    scoreRowsEl.appendChild(row);
  }
}

function updateWeaponHud() {
  const reloadText = localReloading ? ' | Reloading...' : '';
  weaponInfoEl.textContent = `${localWeaponName} | ${localAmmoMag} / ${localAmmoReserve}${reloadText}`;
  roundTimerEl.textContent = `Round: ${formatRoundTime(roundTimeLeft)}`;
}

function getWeaponConfigById(weaponId) {
  return availableWeapons.find((w) => w.id === weaponId) || null;
}

function createWeaponButtons() {
  weaponButtonsEl.innerHTML = '';
  for (const weapon of availableWeapons) {
    const btn = document.createElement('button');
    btn.className = 'weaponButton';
    btn.textContent = weapon.name;
    if (weapon.id === selectedWeapon) {
      btn.classList.add('selected');
    }
    btn.addEventListener('click', () => {
      selectedWeapon = weapon.id;
      if (socket) {
        socket.emit('selectWeapon', weapon.id);
      }
      createWeaponButtons(); // Update selected state
    });
    weaponButtonsEl.appendChild(btn);
  }
}

function createTracerBullet(origin, targetPos, color = 0xffcc00) {
  const start = new THREE.Vector3(origin.x, origin.y, origin.z);
  const end = new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z);
  const distance = start.distanceTo(end);
  if (distance < 0.1) {
    return;
  }

  const geometry = new THREE.CylinderGeometry(0.03, 0.03, distance, 8, 1, false);
  const material = new THREE.MeshBasicMaterial({ color, fog: false, transparent: true, opacity: 0.9 });
  const tracer = new THREE.Mesh(geometry, material);
  const mid = start.clone().lerp(end, 0.5);
  tracer.position.copy(mid);
  tracer.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize());
  scene.add(tracer);
  tracerMeshes.push({ mesh: tracer, createdAt: performance.now() });
}

function createImpactEffect(position, color = 0xffd27a) {
  const geometry = new THREE.SphereGeometry(0.11, 8, 8);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    fog: false,
  });

  const spark = new THREE.Mesh(geometry, material);
  spark.position.set(position.x, position.y, position.z);
  scene.add(spark);

  impactEffects.push({
    mesh: spark,
    material,
    createdAt: performance.now(),
    durationMs: 140,
  });
}

function updateDeathScreen() {
  if (!localAlive) {
    if (respawnStartTime <= 0) {
      respawnStartTime = performance.now();
    }
    deathScreenEl.classList.remove('hidden');
    const elapsed = (performance.now() - respawnStartTime) * 0.001;
    const remaining = Math.max(0, respawnDuration - elapsed);
    respawnCountdownEl.textContent = Math.ceil(remaining);
  } else {
    deathScreenEl.classList.add('hidden');
  }
}

function updateOrCreatePlayer(serverPlayer) {
  let p = remotePlayers.get(serverPlayer.id);

  if (!p) {
    p = createPlayerVisual(serverPlayer.color);
    remotePlayers.set(serverPlayer.id, p);
  }

  p.tag.textContent = serverPlayer.name;
  p.targetPosition.set(serverPlayer.x, serverPlayer.y, serverPlayer.z);
  p.targetYaw = serverPlayer.yaw;
}

function removeMissingPlayers(serverStatePlayers) {
  for (const [id, p] of remotePlayers) {
    if (!serverStatePlayers[id]) {
      destroyPlayerVisual(p);
      remotePlayers.delete(id);
    }
  }
}

function wireSocketEvents() {
  socket.on('connect', () => {
    console.log('Connected to server');
    statusEl.textContent = 'Connected. Waiting for world state...';
  });

  socket.on('disconnect', () => {
    console.log('Disconnected from server');
    statusEl.textContent = 'Disconnected from server.';
  });

  socket.on('connect_error', (err) => {
    console.error('Connection error:', err);
    statusEl.textContent = `Connect failed: ${err.message}`;
  });

  socket.on('welcome', (data) => {
    console.log('Welcome event received:', data);
    localId = data.id;
    worldBounds = data.worldBounds;
    maxHealth = Number.isFinite(data.maxHealth) ? data.maxHealth : 100;
    maxStamina = Number.isFinite(data.maxStamina) ? data.maxStamina : 100;
    localHealth = maxHealth;
    localStamina = maxStamina;
    
    // Handle new weapons array
    if (Array.isArray(data.weapons)) {
      availableWeapons = data.weapons;

      const defaultWeapon = availableWeapons.find(w => w.id === (data.defaultWeapon || 'rifle'));
      if (defaultWeapon) {
        selectedWeapon = defaultWeapon.id;
        localWeaponName = defaultWeapon.name;
        localAmmoMag = defaultWeapon.magSize;
        localAmmoReserve = defaultWeapon.reserveSize;
        weaponFireInterval = defaultWeapon.fireInterval;
      }
      createWeaponButtons();
    } else if (data.weapon) {
      // Fallback for old single-weapon format
      localWeaponName = data.weapon.name || localWeaponName;
      localAmmoMag = data.weapon.magSize || localAmmoMag;
      localAmmoReserve = data.weapon.reserveSize || localAmmoReserve;
      weaponFireInterval = data.weapon.fireInterval || weaponFireInterval;
    }
    
    roundTimeLeft = data.roundDuration || roundTimeLeft;
    buildMap(data.obstacles || []);

    updateSunPosition(0);
    updateSkyColor(0);

    statusEl.textContent = `Connected | id ${localId.slice(0, 6)} | server ${data.tickRate}Hz`;
    updateWeaponHud();
    console.log('Welcome event processed');
  });

  socket.on('chatMessage', (msg) => {
    addChatLine(msg);
  });

  socket.on('killFeed', (entry) => {
    addKillFeedItem(entry);
  });

  socket.on('hitConfirm', (data) => {
    hitMarkerUntil = performance.now() + 130;
  });

  socket.on('shotTrace', (data) => {
    if (!data || !data.origin || !data.end) {
      return;
    }

    let visualOrigin = data.origin;
    if (data.shooterId === localId) {
      const look = new THREE.Vector3(
        Math.sin(cameraYaw) * Math.cos(cameraPitch),
        Math.sin(cameraPitch),
        Math.cos(cameraYaw) * Math.cos(cameraPitch)
      ).normalize();
      const right = new THREE.Vector3().crossVectors(look, UP).normalize();

      visualOrigin = {
        x: camera.position.x - look.x * 0.35 + right.x * 0.14,
        y: camera.position.y - 0.34,
        z: camera.position.z - look.z * 0.35 + right.z * 0.14,
      };
    }

    const color = data.shooterId === localId ? 0xfff177 : 0xff8a47;
    createTracerBullet(visualOrigin, data.end, color);

    if (data.impact) {
      const impactColor = data.hit ? 0xff9f6d : 0xffd27a;
      createImpactEffect(data.end, impactColor);
    }
  });

  socket.on('worldState', (packet) => {
    try {
      if (!packet || packet.seq <= latestSeq) {
        return;
      }

      latestSeq = packet.seq;
      if (Number.isFinite(packet.roundTimeLeft)) {
        roundTimeLeft = packet.roundTimeLeft;
      }

      const players = packet.players || {};

      if (localId && players[localId]) {
        const self = players[localId];
        localHealth = Number.isFinite(self.health) ? self.health : localHealth;
        localStamina = Number.isFinite(self.stamina) ? self.stamina : localStamina;
        localSprinting = !!self.sprinting;
        
        // Handle death state transition
        const wasAlive = localAlive;
        localAlive = self.alive !== false;
        if (wasAlive && !localAlive && respawnStartTime === 0) {
          respawnStartTime = performance.now();
        }
        
        localKills = self.kills ?? localKills;
        localDeaths = self.deaths ?? localDeaths;
        localAmmoMag = Number.isFinite(self.ammoMag) ? self.ammoMag : localAmmoMag;
        localAmmoReserve = Number.isFinite(self.ammoReserve) ? self.ammoReserve : localAmmoReserve;
        localReloading = !!self.reloading;

        if (typeof self.equippedWeapon === 'string') {
          selectedWeapon = self.equippedWeapon;
          const cfg = getWeaponConfigById(self.equippedWeapon);
          if (cfg) {
            localWeaponName = cfg.name;
            weaponFireInterval = cfg.fireInterval;
          }
        }
      }

      for (const id of Object.keys(players)) {
        updateOrCreatePlayer(players[id]);
      }

      removeMissingPlayers(players);
      updateScoreboard(players);
      updateWeaponHud();
    } catch (err) {
      console.error('Error processing worldState:', err);
    }
  });
}

function connectWithName(displayName) {
  socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    timeout: 10000,
    query: { name: displayName || '' },
  });

  wireSocketEvents();
  loginOverlayEl.classList.add('hidden');
}

function decodeJwtPayload(jwt) {
  try {
    const payload = jwt.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function initGoogleSignIn() {
  const clientId = window.GOOGLE_CLIENT_ID || '';
  if (!clientId || !window.google?.accounts?.id) {
    loginHintEl.textContent = 'Google sign-in not configured. Add GOOGLE_CLIENT_ID in public/config.js';
    return;
  }

  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: (response) => {
      const payload = decodeJwtPayload(response.credential || '');
      if (!payload?.name) {
        loginHintEl.textContent = 'Google login failed. Try again.';
        return;
      }
      localStorage.setItem('displayName', payload.name);
      connectWithName(payload.name);
    },
  });

  window.google.accounts.id.prompt();
}

function updateBars() {
  const healthPct = maxHealth > 0 ? Math.max(0, Math.min(1, localHealth / maxHealth)) : 0;
  const staminaPct = maxStamina > 0 ? Math.max(0, Math.min(1, localStamina / maxStamina)) : 0;

  healthFillEl.style.width = `${healthPct * 100}%`;
  staminaFillEl.style.width = `${staminaPct * 100}%`;
  healthTextEl.textContent = `${Math.round(localHealth)}`;
  staminaTextEl.textContent = `${Math.round(localStamina)}`;

  staminaFillEl.style.filter = localSprinting ? 'saturate(1.25) brightness(1.08)' : 'none';
}

chatForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !socket) {
    return;
  }

  socket.emit('chatMessage', { text });
  chatInput.value = '';
});

window.addEventListener('keydown', (ev) => {
  if (ev.repeat) {
    return;
  }

  if (ev.code === 'Enter') {
    if (document.activeElement === chatInput) {
      chatForm.requestSubmit();
    } else {
      chatInput.focus();
    }
    return;
  }

  if (document.activeElement === chatInput) {
    return;
  }

  if (ev.code === 'Tab') {
    ev.preventDefault();
    scoreboardEl.classList.remove('hidden');
  }

  if (ev.code === 'KeyW') input.forward = true;
  if (ev.code === 'KeyS') input.backward = true;
  if (ev.code === 'KeyA') input.left = true;
  if (ev.code === 'KeyD') input.right = true;
  if (ev.code === 'ShiftLeft' || ev.code === 'ShiftRight') input.sprint = true;
  if (ev.code === 'Space') {
    ev.preventDefault();
    input.jump = true;
  }
  if (ev.code === 'Escape') {
    if (document.pointerLockElement === renderer.domElement) {
      document.exitPointerLock();
    }
  }
});

window.addEventListener('keyup', (ev) => {
  if (ev.code === 'KeyW') input.forward = false;
  if (ev.code === 'KeyS') input.backward = false;
  if (ev.code === 'KeyA') input.left = false;
  if (ev.code === 'KeyD') input.right = false;
  if (ev.code === 'ShiftLeft' || ev.code === 'ShiftRight') input.sprint = false;
  if (ev.code === 'Space') input.jump = false;
  if (ev.code === 'KeyR' && socket) {
    socket.emit('reload');
  }
  if (ev.code === 'Tab') {
    scoreboardEl.classList.add('hidden');
  }
});

window.addEventListener('mousedown', (ev) => {
  if (document.activeElement === chatInput) {
    return;
  }
  if (ev.button === 0) {
    shootingHeld = true;
  }
});

window.addEventListener('mouseup', (ev) => {
  if (ev.button === 0) {
    shootingHeld = false;
  }
});

window.addEventListener('mousemove', (ev) => {
  if (document.activeElement === chatInput) {
    return;
  }

  cameraYaw -= ev.movementX * 0.004;
  cameraPitch -= ev.movementY * 0.004;
  cameraPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, cameraPitch));
});

// Request pointer lock for FPS controls
renderer.domElement.addEventListener('click', () => {
  renderer.domElement.requestPointerLock = renderer.domElement.requestPointerLock || renderer.domElement.mozRequestPointerLock;
  renderer.domElement.requestPointerLock();
});

// Exit pointer lock when pressing Escape or clicking chat
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement) {
    // Pointer lock was exited
  }
});

chatInput.addEventListener('focus', () => {
  if (document.pointerLockElement === renderer.domElement) {
    document.exitPointerLock();
  }
});

setInterval(() => {
  if (!socket) {
    return;
  }

  const forwardInput = (input.forward ? 1 : 0) - (input.backward ? 1 : 0);
  const rightInput = (input.right ? 1 : 0) - (input.left ? 1 : 0);

  // Build movement from camera basis vectors so WASD is always camera-relative.
  moveForwardVec.set(Math.sin(cameraYaw), 0, Math.cos(cameraYaw));
  if (moveForwardVec.lengthSq() < 1e-6) {
    moveForwardVec.set(0, 0, 1);
  } else {
    moveForwardVec.normalize();
  }

  moveRightVec.crossVectors(moveForwardVec, UP).normalize();

  moveWorldVec
    .copy(moveForwardVec)
    .multiplyScalar(forwardInput)
    .addScaledVector(moveRightVec, rightInput);

  if (moveWorldVec.lengthSq() > 1) {
    moveWorldVec.normalize();
  }

  socket.emit('input', {
    moveX: moveWorldVec.x,
    moveZ: moveWorldVec.z,
    yaw: cameraYaw,
    pitch: cameraPitch,
    jump: input.jump,
    sprint: input.sprint,
  });

  const now = performance.now() * 0.001;
  if (shootingHeld && localAlive && !localReloading && localAmmoMag > 0 && now >= nextShootAt) {
    socket.emit('shoot');
    nextShootAt = now + weaponFireInterval;
  }
}, 1000 / 60);

function animate() {
  requestAnimationFrame(animate);

  const alpha = 0.85;
  const self = localId ? remotePlayers.get(localId) : null;
  const nowSec = performance.now() * 0.001;

  // Clean up old tracers (remove after 0.5 seconds)
  for (let i = tracerMeshes.length - 1; i >= 0; i--) {
    const tracer = tracerMeshes[i];
    if (nowSec * 1000 - tracer.createdAt > 500) {
      scene.remove(tracer.mesh);
      tracer.mesh.geometry?.dispose();
      tracer.mesh.material?.dispose();
      tracerMeshes.splice(i, 1);
    }
  }

  for (let i = impactEffects.length - 1; i >= 0; i--) {
    const effect = impactEffects[i];
    const ageMs = nowSec * 1000 - effect.createdAt;
    const t = Math.min(1, Math.max(0, ageMs / effect.durationMs));

    effect.material.opacity = 0.95 * (1 - t);
    effect.mesh.scale.setScalar(1 + t * 1.6);

    if (ageMs >= effect.durationMs) {
      scene.remove(effect.mesh);
      effect.mesh.geometry?.dispose();
      effect.material.dispose();
      impactEffects.splice(i, 1);
    }
  }

  for (const [id, p] of remotePlayers) {
    p.group.position.lerp(p.targetPosition, alpha);

    let delta = p.targetYaw - p.group.rotation.y;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    p.group.rotation.y += delta * alpha;

    const projected = p.group.position.clone();
    projected.y += 2.2;
    projected.project(camera);

    // Hide only the local capsule mesh
    const isLocalPlayer = id === localId;
    p.body.visible = !isLocalPlayer;

    if (isLocalPlayer) {
      // Skip flashlight positioning for local player
    } else {
      // Skip flashlight positioning for remote players
    }

    const x = (projected.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-projected.y * 0.5 + 0.5) * window.innerHeight;
    p.tag.style.left = `${x}px`;
    p.tag.style.top = `${y}px`;
    p.tag.style.display = isLocalPlayer ? 'none' : (projected.z < 1 ? 'block' : 'none');
  }

  if (self) {
    // FPS camera at player eye height - no smoothing for precision
    const eyeHeight = 1.6;
    camera.position.copy(
      self.group.position.clone().add(new THREE.Vector3(0, eyeHeight, 0))
    );

    // Look direction based on camera yaw and pitch
    const lookDirection = new THREE.Vector3();
    lookDirection.x = Math.sin(cameraYaw) * Math.cos(cameraPitch);
    lookDirection.y = Math.sin(cameraPitch);
    lookDirection.z = Math.cos(cameraYaw) * Math.cos(cameraPitch);
    
    camera.lookAt(camera.position.clone().add(lookDirection));

    const distToBorderX = Math.max(0, Math.abs(self.group.position.x) - worldBounds + 2);
    const distToBorderZ = Math.max(0, Math.abs(self.group.position.z) - worldBounds + 2);
    const edgeWarning = distToBorderX + distToBorderZ;

    const stateText = localAlive ? '' : ' | Respawning';
    const kdText = ` | K:${localKills} D:${localDeaths}`;
    if (edgeWarning > 0) {
      statusEl.textContent = `Connected | Near map edge (${worldBounds})${stateText}${kdText}`;
    } else {
      statusEl.textContent = `Connected | id ${localId.slice(0, 6)}${stateText}${kdText}`;
    }
  }

  hitMarkerEl.style.opacity = performance.now() < hitMarkerUntil ? '0.9' : '0';

  // Update death screen
  updateDeathScreen();
  
  // Reset respawn timer if player is alive again
  if (localAlive && respawnStartTime > 0) {
    respawnStartTime = 0;
  }

  renderer.render(scene, camera);
  updateBars();
  updateWeaponHud();
}

animate();

nameInputEl.value = localStorage.getItem('displayName') || '';
guestBtnEl.addEventListener('click', () => {
  const fallback = `Player-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;
  const chosen = (nameInputEl.value || '').trim().slice(0, 16) || fallback;
  localStorage.setItem('displayName', chosen);
  connectWithName(chosen);
});

googleBtnEl.addEventListener('click', () => {
  initGoogleSignIn();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
