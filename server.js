// server.js
import { WebSocketServer } from "ws";
import pkg from "matter-js";
const { Engine, Events, Runner, Composite, Body, Bodies } = pkg;
import { v4 as uuidv4 } from "uuid";

const wss = new WebSocketServer({ port: 8080 });

const engine = Engine.create();
const runner = Runner.create();
Runner.run(runner, engine);

const players = {}; // { id: { body, inputQueue, canJump } }

const platforms = [
  { x: 0, y: 290, w: 800, h: 20 },
  { x: -300, y: 200, w: 120, h: 20 },
  { x: 200, y: 200, w: 120, h: 20 },
  { x: 0, y: 100, w: 180, h: 20 },
  { x: -250, y: -50, w: 100, h: 20 },
  { x: 250, y: -50, w: 100, h: 20 },
  { x: 0, y: -150, w: 150, h: 20 },
];

const platformBodies = platforms.map(p =>
  Bodies.rectangle(p.x, p.y, p.w, p.h, { isStatic: true })
);
Composite.add(engine.world, platformBodies);

function applyInput(player, input) {
  const body = player.body;
  const force = 0.0008;
  const jumpForce = -0.04;

  if (input.keys.a) Body.applyForce(body, body.position, { x: -force, y: 0 });
  if (input.keys.d) Body.applyForce(body, body.position, { x: force, y: 0 });
  if (input.keys.w && player.canJump) {
    Body.applyForce(body, body.position, { x: 0, y: jumpForce });
    player.canJump = false;
  }
}

Events.on(engine, "collisionStart", (e) => {
  e.pairs.forEach((pair) => {
    for (const id in players) {
      if (pair.bodyA === players[id].body || pair.bodyB === players[id].body) {
        players[id].canJump = true;
      }
    }
  });
});

function broadcastSnapshot() {
  const snapshot = [];

  for (const id in players) {
    const player = players[id];
    snapshot.push({
      id,
      x: player.body.position.x,
      y: player.body.position.y,
      lastProcessedInput: player.lastProcessedInput ?? 0,
    });
  }

  const message = JSON.stringify({
    type: "snapshot",
    players: snapshot,
  });

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

setInterval(() => {
  // Processa inputs de cada player em ordem
  for (const id in players) {
    const player = players[id];

    // Ordena inputs por timestamp
    player.inputQueue.sort((a, b) => a.timestamp - b.timestamp);

    while (player.inputQueue.length > 0) {
      const input = player.inputQueue.shift(); // FIFO
      applyInput(player, input);
      player.lastProcessedInput = input.timestamp;
    }
  }

  broadcastSnapshot();
}, 1000 / 30); // 30 FPS

wss.on("connection", (ws) => {
  const id = uuidv4();
  console.log("Player connected:", id);

  const body = Bodies.circle(0, 0, 20, { restitution: 0, friction: 0.05 });
  Composite.add(engine.world, body);

  players[id] = {
    body,
    inputQueue: [],
    lastProcessedInput: null,
    canJump: false,
  };

  ws.send(JSON.stringify({
    type: "welcome",
    id,
    map: platforms,
  }));

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "input") {
        players[id].inputQueue.push(data);
      }
    } catch (err) {
      console.error("Invalid message", err);
    }
  });

  ws.on("close", () => {
    console.log("Player disconnected:", id);
    Composite.remove(engine.world, players[id].body);
    delete players[id];
  });
});

console.log("✅ Server with rollback running on ws://localhost:8080");
