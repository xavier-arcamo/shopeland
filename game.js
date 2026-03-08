import * as THREE from 'https://unpkg.com/three@0.161.0/build/three.module.js';

const canvas = document.querySelector('#gameCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x89b9d9);
scene.fog = new THREE.Fog(0x89b9d9, 90, 340);

const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 650);
camera.position.set(70, 95, 70);
camera.lookAt(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xcce8ff, 0x3f3a24, 0.85));
const sun = new THREE.DirectionalLight(0xfff3d0, 1.15);
sun.position.set(120, 150, 80);
sun.castShadow = true;
scene.add(sun);

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let terrainMesh;
let keep;
let keepBanner;
let mapData;

const state = {
  gold: 300,
  food: 120,
  population: 18,
  populationCap: 40,
  paused: false,
  attackMove: false,
  gameOver: false,
  victoryTimer: 240,
  sheep: [],
  wolves: [],
  selectedDivisionIds: new Set(),
  eventQueue: [],
  drag: { active: false, start: new THREE.Vector2(), end: new THREE.Vector2() },
};

const ui = {
  gold: document.querySelector('#gold'),
  food: document.querySelector('#food'),
  population: document.querySelector('#population'),
  selected: document.querySelector('#selected'),
  events: document.querySelector('#events'),
  unitCards: document.querySelector('#unitCards'),
};

const terrainHeight = (x, z) => {
  if (!mapData) return 0;
  const { terrain } = mapData;
  let h = terrain.baseHeight || 0;

  for (const hill of terrain.rolling || []) {
    const dx = x - hill.x;
    const dz = z - hill.z;
    h += hill.height * Math.exp(-(dx * dx + dz * dz) / (2 * hill.radius * hill.radius));
  }
  for (const mount of terrain.mountains || []) {
    const dx = x - mount.x;
    const dz = z - mount.z;
    h += mount.height * Math.exp(-(dx * dx + dz * dz) / (2 * mount.radius * mount.radius));
  }

  for (const river of terrain.rivers || []) {
    const s = new THREE.Vector2(river.start.x, river.start.z);
    const e = new THREE.Vector2(river.end.x, river.end.z);
    const p = new THREE.Vector2(x, z);
    const se = new THREE.Vector2().subVectors(e, s);
    const t = THREE.MathUtils.clamp(new THREE.Vector2().subVectors(p, s).dot(se) / se.lengthSq(), 0, 1);
    const nearest = new THREE.Vector2().copy(s).addScaledVector(se, t);
    const d = p.distanceTo(nearest);
    h -= river.depth * Math.exp(-(d * d) / (2 * (river.width * 0.7) ** 2));
  }

  for (const lake of terrain.lakes || []) {
    const dx = x - lake.x;
    const dz = z - lake.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < lake.radius * 1.8) {
      h -= lake.depth * Math.exp(-(d * d) / (2 * (lake.radius * 0.95) ** 2));
    }
  }

  return h;
};

const addEvent = (text, type = 'good') => {
  state.eventQueue.unshift({ text, type });
  state.eventQueue = state.eventQueue.slice(0, 8);
  ui.events.innerHTML = state.eventQueue.map((e) => `<div class="event-${e.type}">${e.text}</div>`).join('');
};

const updateHud = () => {
  ui.gold.textContent = Math.floor(state.gold);
  ui.food.textContent = Math.floor(state.food);
  ui.population.textContent = `${state.population}/${state.populationCap}`;
  ui.selected.textContent = state.selectedDivisionIds.size ? `${state.selectedDivisionIds.size} division(s)` : 'None';
};

const refreshUnitCards = () => {
  ui.unitCards.innerHTML = '';
  for (const div of state.sheep) {
    const card = document.createElement('div');
    card.className = `unit-card ${state.selectedDivisionIds.has(div.id) ? 'selected' : ''} ${div.isAlive() ? '' : 'dead'}`;
    const hpPct = Math.max(0, Math.round((div.hp / div.maxHp) * 100));
    card.innerHTML = `
      <div class="unit-card-title">${div.label}</div>
      <div>${div.size} troops · ATK ${div.attack}</div>
      <div class="hp-bar"><div style="width:${hpPct}%"></div></div>
    `;
    card.addEventListener('click', (event) => {
      if (!event.shiftKey) state.selectedDivisionIds.clear();
      if (state.selectedDivisionIds.has(div.id)) state.selectedDivisionIds.delete(div.id);
      else state.selectedDivisionIds.add(div.id);
      syncSelection();
    });
    ui.unitCards.append(card);
  }
};

const syncSelection = () => {
  state.sheep.forEach((d) => d.setSelected(state.selectedDivisionIds.has(d.id)));
  updateHud();
  refreshUnitCards();
};

class Division {
  constructor({ id, label, faction, color, position, size = 12, hp = 320, speed = 8, attack = 22, range = 8 }) {
    this.id = id;
    this.label = label;
    this.faction = faction;
    this.hp = hp;
    this.maxHp = hp;
    this.attack = attack;
    this.range = range;
    this.size = size;
    this.speed = speed;
    this.cooldown = 0;
    this.target = null;
    this.destination = position.clone();

    this.group = new THREE.Group();
    this.group.position.copy(position);

    const banner = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.5, 0.3), new THREE.MeshStandardMaterial({ color: 0x4d331f }));
    banner.position.y = 2.5;
    const cloth = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1, 0.12), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.12 }));
    cloth.position.set(0.7, 3.3, 0);
    this.group.add(banner, cloth);

    const troopGeom = new THREE.CapsuleGeometry(0.28, 0.7, 4, 8);
    const troopMat = new THREE.MeshStandardMaterial({ color });
    const root = Math.ceil(Math.sqrt(size));
    for (let i = 0; i < size; i += 1) {
      const mesh = new THREE.Mesh(troopGeom, troopMat);
      mesh.castShadow = true;
      mesh.position.set((i % root) * 0.9 - (root * 0.9) / 2, 0.7, Math.floor(i / root) * 0.9 - (root * 0.9) / 2);
      this.group.add(mesh);
    }

    this.ring = new THREE.Mesh(new THREE.TorusGeometry(2, 0.15, 8, 24), new THREE.MeshBasicMaterial({ color: faction === 'sheep' ? 0x88d0ff : 0xff8877 }));
    this.ring.rotation.x = Math.PI / 2;
    this.ring.visible = false;
    this.group.add(this.ring);

    scene.add(this.group);
  }

  setSelected(selected) { this.ring.visible = selected; }
  isAlive() { return this.hp > 0; }

  findClosestEnemy(pool) {
    let best;
    let minDist = Infinity;
    for (const enemy of pool) {
      if (!enemy.isAlive()) continue;
      const d = this.group.position.distanceTo(enemy.group.position);
      if (d < minDist) {
        minDist = d;
        best = enemy;
      }
    }
    return best;
  }

  update(dt, enemyPool) {
    if (!this.isAlive()) return;
    this.cooldown = Math.max(0, this.cooldown - dt);

    if (!this.target || !this.target.isAlive()) this.target = this.findClosestEnemy(enemyPool);

    if (this.target?.isAlive()) {
      const d = this.group.position.distanceTo(this.target.group.position);
      if (d <= this.range && this.cooldown <= 0) {
        this.target.hp -= this.attack;
        this.cooldown = 1.2;
      } else if (d > this.range) {
        this.destination.copy(this.target.group.position);
      }
    }

    const dir = new THREE.Vector3().subVectors(this.destination, this.group.position);
    dir.y = 0;
    const dist = dir.length();
    if (dist > 0.3) {
      dir.normalize();
      this.group.position.addScaledVector(dir, Math.min(dist, this.speed * dt));
    }
    this.group.position.y = terrainHeight(this.group.position.x, this.group.position.z) + 0.1;

    const hpRatio = Math.max(0.08, this.hp / this.maxHp);
    this.group.scale.set(1, hpRatio, 1);
  }

  dispose() { scene.remove(this.group); }
}

let divisionId = 0;
const spawnDivision = (faction, position, options = {}) => {
  divisionId += 1;
  const defaults = faction === 'sheep'
    ? { color: 0xf2f2ff, hp: 320, attack: 22, size: 12, range: 8, speed: 8, label: `Woolguard #${divisionId}` }
    : { color: 0x775141, hp: 300, attack: 19, size: 11, range: 7, speed: 7, label: `Ironfang #${divisionId}` };

  const y = terrainHeight(position.x, position.z) + 0.1;
  const div = new Division({ id: divisionId, faction, position: new THREE.Vector3(position.x, y, position.z), ...defaults, ...options });
  state[faction === 'sheep' ? 'sheep' : 'wolves'].push(div);
  refreshUnitCards();
  return div;
};

const buildTerrain = () => {
  const size = mapData.size;
  const segments = 128;
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  const pos = geometry.attributes.position;
  const colors = [];

  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const z = pos.getY(i);
    const y = terrainHeight(x, z);
    pos.setZ(i, y);

    const waterish = y < -1.5;
    if (waterish) colors.push(0.12, 0.32, 0.52);
    else if (y > 13) colors.push(0.5, 0.5, 0.52);
    else if (y > 6) colors.push(0.44, 0.58, 0.34);
    else colors.push(0.35, 0.52, 0.28);
  }

  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  terrainMesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.05 })
  );
  terrainMesh.rotation.x = -Math.PI / 2;
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);
};

const makeTree = (x, z) => {
  const y = terrainHeight(x, z);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.36, 2.2, 8), new THREE.MeshStandardMaterial({ color: 0x5e452f }));
  trunk.position.set(x, y + 1.1, z);
  const crown = new THREE.Mesh(new THREE.ConeGeometry(1.5, 3.6, 8), new THREE.MeshStandardMaterial({ color: 0x2c5f31 }));
  crown.position.set(x, y + 3.2, z);
  scene.add(trunk, crown);
};

const decorateMap = () => {
  for (const cluster of mapData.features.trees || []) {
    for (let i = 0; i < cluster.count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * cluster.spread;
      makeTree(cluster.x + Math.cos(angle) * radius, cluster.z + Math.sin(angle) * radius);
    }
  }

  for (const town of mapData.features.settlements || []) {
    for (let i = 0; i < town.houses; i += 1) {
      const ox = (Math.random() - 0.5) * 10;
      const oz = (Math.random() - 0.5) * 10;
      const x = town.x + ox;
      const z = town.z + oz;
      const y = terrainHeight(x, z);
      const house = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.8, 2), new THREE.MeshStandardMaterial({ color: 0xbca182 }));
      house.position.set(x, y + 0.9, z);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.8, 1.2, 4), new THREE.MeshStandardMaterial({ color: 0x6a2f25 }));
      roof.position.set(x, y + 2.2, z);
      roof.rotation.y = Math.PI * 0.25;
      scene.add(house, roof);
    }
  }

  for (const tower of mapData.features.towers || []) {
    const y = terrainHeight(tower.x, tower.z);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.5, 6, 8), new THREE.MeshStandardMaterial({ color: 0xb8b9bf }));
    mesh.position.set(tower.x, y + 3, tower.z);
    mesh.castShadow = true;
    scene.add(mesh);
  }

  for (const bridge of mapData.features.bridges || []) {
    const y = terrainHeight(bridge.x, bridge.z);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(bridge.length, 0.5, 3.5), new THREE.MeshStandardMaterial({ color: 0x7b5b3d }));
    mesh.position.set(bridge.x, y + 1.2, bridge.z);
    mesh.rotation.y = bridge.angle;
    scene.add(mesh);
  }
};

const placeKeep = () => {
  const x = mapData.centerKeep.x;
  const z = mapData.centerKeep.z;
  const y = terrainHeight(x, z);
  keep = new THREE.Mesh(new THREE.CylinderGeometry(8, 10, 9, 8), new THREE.MeshStandardMaterial({ color: 0xb7b9bd }));
  keep.position.set(x, y + 4.5, z);
  keep.castShadow = true;
  keepBanner = new THREE.Mesh(new THREE.BoxGeometry(1, 7, 3), new THREE.MeshStandardMaterial({ color: 0xe2d8ff, emissive: 0x221433 }));
  keepBanner.position.set(x, y + 9, z + 8);
  scene.add(keep, keepBanner);
};

const issueMoveOrder = (targetPoint) => {
  const selected = state.sheep.filter((d) => state.selectedDivisionIds.has(d.id) && d.isAlive());
  if (!selected.length) return;
  const cols = Math.ceil(Math.sqrt(selected.length));
  selected.forEach((div, index) => {
    const offsetX = ((index % cols) - cols / 2) * 4;
    const offsetZ = (Math.floor(index / cols) - cols / 2) * 4;
    div.destination.set(targetPoint.x + offsetX, terrainHeight(targetPoint.x + offsetX, targetPoint.z + offsetZ), targetPoint.z + offsetZ);
    div.target = state.attackMove ? div.findClosestEnemy(state.wolves) : null;
  });
};

const issueMassAttack = () => {
  const selected = state.sheep.filter((d) => state.selectedDivisionIds.has(d.id) && d.isAlive());
  if (!selected.length) return;
  selected.forEach((div) => { div.target = div.findClosestEnemy(state.wolves); });
  addEvent('Mass attack order issued.', 'good');
};

const clearDeadAndSelection = () => {
  for (const pool of [state.sheep, state.wolves]) {
    for (const d of pool) if (!d.isAlive()) d.dispose();
  }
  state.sheep = state.sheep.filter((d) => d.isAlive());
  state.wolves = state.wolves.filter((d) => d.isAlive());
  state.selectedDivisionIds.forEach((id) => {
    if (!state.sheep.find((d) => d.id === id)) state.selectedDivisionIds.delete(id);
  });
};

const pointerToNDC = (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
};

const selectByBox = (append = false) => {
  const minX = Math.min(state.drag.start.x, state.drag.end.x);
  const maxX = Math.max(state.drag.start.x, state.drag.end.x);
  const minY = Math.min(state.drag.start.y, state.drag.end.y);
  const maxY = Math.max(state.drag.start.y, state.drag.end.y);
  if (!append) state.selectedDivisionIds.clear();

  const v = new THREE.Vector3();
  for (const div of state.sheep) {
    if (!div.isAlive()) continue;
    v.copy(div.group.position).project(camera);
    const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
    if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) state.selectedDivisionIds.add(div.id);
  }
  syncSelection();
};

const setupInput = () => {
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('pointerdown', (event) => {
    if (state.gameOver) return;
    pointerToNDC(event);

    if (event.button === 0) {
      state.drag.active = true;
      state.drag.start.set(event.clientX, event.clientY);
      state.drag.end.copy(state.drag.start);
    }

    if (event.button === 2) {
      raycaster.setFromCamera(mouse, camera);
      const hit = raycaster.intersectObject(terrainMesh)[0];
      if (hit) {
        issueMoveOrder(hit.point);
        addEvent(`Move order to ${hit.point.x.toFixed(0)}, ${hit.point.z.toFixed(0)}.`, 'good');
      }
    }
  });

  window.addEventListener('pointermove', (event) => {
    if (state.drag.active) state.drag.end.set(event.clientX, event.clientY);
  });

  window.addEventListener('pointerup', (event) => {
    if (event.button !== 0 || !state.drag.active) return;
    state.drag.active = false;
    selectByBox(event.shiftKey);
  });

  const cam = { left: false, right: false, up: false, down: false };

  window.addEventListener('keydown', (event) => {
    const k = event.key.toLowerCase();
    if (k === 'a') {
      state.attackMove = !state.attackMove;
      addEvent(`Attack-move ${state.attackMove ? 'enabled' : 'disabled'}.`, state.attackMove ? 'good' : 'bad');
    }
    if (k === 'f') issueMassAttack();
    if (k === 'r') issueMoveOrder(new THREE.Vector3(mapData.centerKeep.x, 0, mapData.centerKeep.z));
    if (event.key === ' ') state.paused = !state.paused;

    if (k === 'arrowleft' || k === 'q') cam.left = true;
    if (k === 'arrowright' || k === 'd') cam.right = true;
    if (k === 'arrowup' || k === 'z' || k === 'w') cam.up = true;
    if (k === 'arrowdown' || k === 's') cam.down = true;
  });

  window.addEventListener('keyup', (event) => {
    const k = event.key.toLowerCase();
    if (k === 'arrowleft' || k === 'q') cam.left = false;
    if (k === 'arrowright' || k === 'd') cam.right = false;
    if (k === 'arrowup' || k === 'z' || k === 'w') cam.up = false;
    if (k === 'arrowdown' || k === 's') cam.down = false;
  });

  const moveCamera = (dt) => {
    const speed = 45 * dt;
    if (cam.left) camera.position.x -= speed;
    if (cam.right) camera.position.x += speed;
    if (cam.up) camera.position.z -= speed;
    if (cam.down) camera.position.z += speed;
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, -110, 110);
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, -110, 110);
    camera.lookAt(0, 0, 0);
  };

  return moveCamera;
};

const attachUiButtons = () => {
  document.querySelector('#recruitInfantry').addEventListener('click', () => {
    if (state.gold < 50 || state.population >= state.populationCap) return;
    state.gold -= 50;
    state.population += 4;
    spawnDivision('sheep', new THREE.Vector3(-48 + Math.random() * 9, 0, -36 + Math.random() * 9));
    addEvent('Woolguard Infantry deployed.', 'good');
  });

  document.querySelector('#recruitKnight').addEventListener('click', () => {
    if (state.gold < 90 || state.population >= state.populationCap) return;
    state.gold -= 90;
    state.population += 3;
    spawnDivision('sheep', new THREE.Vector3(-48 + Math.random() * 9, 0, -36 + Math.random() * 9), {
      size: 8,
      hp: 280,
      attack: 38,
      speed: 11,
      color: 0xd7ecff,
      label: `Ram Knights #${divisionId + 1}`,
    });
    addEvent('Ram Knights thunder to battle.', 'good');
  });

  document.querySelector('#togglePause').addEventListener('click', () => { state.paused = !state.paused; });
  document.querySelector('#massAttack').addEventListener('click', issueMassAttack);
  document.querySelector('#regroup').addEventListener('click', () => issueMoveOrder(new THREE.Vector3(mapData.centerKeep.x, 0, mapData.centerKeep.z)));
  document.querySelector('#clearSelection').addEventListener('click', () => {
    state.selectedDivisionIds.clear();
    syncSelection();
  });
};

const clock = new THREE.Clock();
let enemyWaveTimer = 15;

const init = async () => {
  const res = await fetch('./map.json');
  mapData = await res.json();

  buildTerrain();
  decorateMap();
  placeKeep();

  for (const p of mapData.spawns.sheep) spawnDivision('sheep', new THREE.Vector3(p.x, 0, p.z));
  spawnDivision('sheep', new THREE.Vector3(mapData.spawns.sheep[0].x + 4, 0, mapData.spawns.sheep[0].z + 5), { size: 9, hp: 250, attack: 30, range: 10, speed: 9, label: 'Shepherd Archers' });
  for (const p of mapData.spawns.wolves) spawnDivision('wolves', new THREE.Vector3(p.x, 0, p.z));

  const moveCamera = setupInput();
  attachUiButtons();

  const animate = () => {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.033);

    if (!state.paused && !state.gameOver) {
      moveCamera(dt);
      state.gold += dt * 6;
      state.food += dt * 2;

      for (const s of state.sheep) s.update(dt, state.wolves);
      for (const w of state.wolves) w.update(dt, state.sheep);

      clearDeadAndSelection();

      enemyWaveTimer -= dt;
      if (enemyWaveTimer <= 0) {
        enemyWaveTimer = 24;
        spawnDivision('wolves', new THREE.Vector3(62 + Math.random() * 20, 0, 28 + Math.random() * 24), {
          size: 9 + Math.floor(Math.random() * 5),
          hp: 280 + Math.random() * 120,
          attack: 20 + Math.random() * 10,
          color: 0x6e3f31,
        });
        addEvent('Ironfang reinforcements approach from the eastern ridge!', 'bad');
      }

      const keepCenter = new THREE.Vector3(mapData.centerKeep.x, 0, mapData.centerKeep.z);
      const sheepInCenter = state.sheep.some((d) => d.group.position.distanceTo(keepCenter) < 18);
      const wolvesInCenter = state.wolves.some((d) => d.group.position.distanceTo(keepCenter) < 18);
      if (sheepInCenter && !wolvesInCenter) {
        state.victoryTimer -= dt;
        keepBanner.material.color.setHex(0xcde8ff);
      } else if (wolvesInCenter) {
        state.victoryTimer += dt * 1.5;
        keepBanner.material.color.setHex(0xffb4a5);
      } else {
        keepBanner.material.color.setHex(0xe2d8ff);
      }
      state.victoryTimer = THREE.MathUtils.clamp(state.victoryTimer, 0, 240);

      if (!state.sheep.length) {
        state.gameOver = true;
        addEvent('Defeat: the Woolguard are broken.', 'bad');
      }
      if (state.victoryTimer <= 0) {
        state.gameOver = true;
        addEvent('Victory! Shopeland stands unconquered.', 'good');
      }
    }

    updateHud();
    refreshUnitCards();
    renderer.render(scene, camera);
  };

  addEvent('Map loaded: Greenflood Marches. Secure the keep and destroy the Ironfang host.', 'good');
  animate();
};

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

init();
