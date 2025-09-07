import { WebSocketServer } from "ws";
import pkg from "matter-js";
const { Engine, Events, Runner, Composite, Body, Bodies, Vector } = pkg;
import { v4 as uuidv4 } from "uuid";

const wss = new WebSocketServer({ port: 8080 });
const TICK_RATE = 1000 / 60;

const rooms = {};

// Gera plataformas
function generatePlatforms() {
  return [
    { x: 0, y: 290, w: 800, h: 20 },
    { x: -300, y: 200, w: 120, h: 20 },
    { x: 200, y: 200, w: 120, h: 20 },
    { x: 0, y: 100, w: 180, h: 20 },
    { x: -250, y: -50, w: 100, h: 20 },
    { x: 250, y: -50, w: 100, h: 20 },
    { x: 0, y: -150, w: 150, h: 20 },
  ];
}

// Cria sala
function createRoom(roomId) {
  const engine = Engine.create();
  const runner = Runner.create();
  const platforms = generatePlatforms();
  const platformBodies = platforms.map(p =>
    Bodies.rectangle(p.x, p.y, p.w, p.h, { isStatic: true })
  );

  Composite.add(engine.world, platformBodies);
  Runner.run(runner, engine);

  const players = {};

  Events.on(engine, "collisionStart", (e) => {
    e.pairs.forEach((pair) => {
      for (const id in players) {
        const player = players[id];
        const body = player.body;

        if (pair.bodyA === body || pair.bodyB === body) {
          const other = pair.bodyA === body ? pair.bodyB : pair.bodyA;

          if (other.isStatic) {
            const contactY = body.position.y;
            const otherY = other.position.y;

            // Garante que o player está acima da plataforma
            if (contactY < otherY) {
              player.canJump = true;
            }
          }
        }
      }
    });
  });

  rooms[roomId] = {
    engine,
    runner,
    players,
    platformBodies,
    platforms,
  };
}

// Aplica input
function applyInput(player, input) {
  const body = player.body;
  const force = 0.0008;
  const jumpForce = -0.04;

  if (input.keys.a) Body.applyForce(body, body.position, { x: -force, y: 0 });
  if (input.keys.d) Body.applyForce(body, body.position, { x: force, y: 0 });

  if (input.keys.w && player.canJump) {
    Body.applyForce(body, body.position, { x: 0, y: jumpForce });
    player.canJump = false; // ✅ impede múltiplos pulos
  }
}

// Tick da sala
function tickRoom(roomId) {
  const room = rooms[roomId];
  const { players, engine } = room;

  for (const id in players) {
    const player = players[id];
    player.inputQueue.sort((a, b) => a.timestamp - b.timestamp);
    while (player.inputQueue.length > 0) {
      const input = player.inputQueue.shift();
      applyInput(player, input);
      player.lastProcessedInput = input.timestamp;
    }
  }

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

  const message = JSON.stringify({ type: "snapshot", players: snapshot });

  for (const id in players) {
    const player = players[id];
    if (player.ws.readyState === 1) {
      player.ws.send(message);
    }
  }
}

// Intervalo de update
setInterval(() => {
  for (const roomId in rooms) {
    tickRoom(roomId);
  }
}, TICK_RATE);

// Nova conexão
wss.on("connection", (ws) => {
  let playerId = uuidv4();
  let roomId = null;

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === "join" && data.match) {
        roomId = `match-${data.match}`;

        if (!rooms[roomId]) {
          createRoom(roomId);
          console.log(`🏗️ Sala criada: ${roomId}`);
        }

        const room = rooms[roomId];
        const body = Bodies.circle(0, 0, 20, { restitution: 0, friction: 0.05 });
        Composite.add(room.engine.world, body);

        room.players[playerId] = {
          body,
          inputQueue: [],
          lastProcessedInput: null,
          canJump: false,
          ws,
        };

        ws.send(JSON.stringify({
          type: "welcome",
          id: playerId,
          map: room.platforms,
        }));

        console.log(`✅ Jogador ${playerId} entrou na sala ${roomId}`);
      }

      if (data.type === "input" && roomId && rooms[roomId]) {
        const player = rooms[roomId].players[playerId];
        if (player) {
          player.inputQueue.push(data);
        }
      }
    } catch (err) {
      console.error("❌ Erro ao processar mensagem:", err);
    }
  });

  ws.on("close", () => {
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      const player = room.players[playerId];
      if (player) {
        Composite.remove(room.engine.world, player.body);
        delete room.players[playerId];
        console.log(`❌ Jogador ${playerId} saiu da sala ${roomId}`);
      }

      if (Object.keys(room.players).length === 0) {
        Runner.stop(room.runner);
        Engine.clear(room.engine);
        delete rooms[roomId];
        console.log(`🧹 Sala ${roomId} encerrada por inatividade`);
      }
    }
  });
});

console.log("🚀 Server running on ws://localhost:8080");
