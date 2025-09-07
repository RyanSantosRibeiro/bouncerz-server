import { WebSocketServer } from "ws";
import pkg from "matter-js";
import { v4 as uuidv4 } from "uuid";

import http from "http";

// cria servidor HTTP
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

const { Engine, Events, Runner, Composite, Body, Bodies } = pkg;

const wss = new WebSocketServer({ server });
const TICK_RATE = 1000 / 60;
const MIN_PLAYERS = 2;
const WINNING_SCORE = 3;
const INACTIVITY_LIMIT = 10 * 60 * 1000; // 10 minutos
const PLAYER_BOUNCE = 0.3; // bounce ao cair
const IMPACT_THRESHOLD = 6; // velocidade mínima para reação de impacto
const IMPACT_FORCE = 0.01; // força aplicada ao quique entre bolas

const rooms = {};

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

function createRoom(roomId) {
  const engine = Engine.create();
  engine.gravity.y = 0.6;
  const runner = Runner.create();
  const platforms = generatePlatforms();
  const platformBodies = platforms.map((p) =>
    Bodies.rectangle(p.x, p.y, p.w, p.h, { isStatic: true })
  );
  Composite.add(engine.world, platformBodies);

  const room = {
    engine,
    runner,
    platforms,
    platformBodies,
    players: {},
    scores: {},
    round: 0,
    status: "waiting",
    createdAt: new Date(),
    lastActivity: new Date(), // Usado para detectar inatividade
  };

  Events.on(engine, "collisionStart", (e) => {
    e.pairs.forEach((pair) => {
      // Lógica para permitir pulo ao tocar em plataforma
      for (const id in room.players) {
        const player = room.players[id];
        if (!player.alive) continue;
        const body = player.body;

        if (pair.bodyA === body || pair.bodyB === body) {
          const other = pair.bodyA === body ? pair.bodyB : pair.bodyA;
          if (other.isStatic && body.position.y < other.position.y) {
            player.canJump = true;
          }
        }
      }

      // ⚡ Reação entre jogadores
      const bodies = Object.values(room.players)
        .filter((p) => p.alive)
        .map((p) => p.body);

      const isPlayerBody = (b) => bodies.includes(b);

      if (isPlayerBody(pair.bodyA) && isPlayerBody(pair.bodyB)) {
        const vA = pair.bodyA.velocity;
        const vB = pair.bodyB.velocity;

        const dx = vA.x - vB.x;
        const dy = vA.y - vB.y;
        const relativeSpeed = Math.sqrt(dx * dx + dy * dy);

        if (relativeSpeed > IMPACT_THRESHOLD) {
          const directionX = dx > 0 ? 1 : -1;
          const directionY = dy > 0 ? 1 : -1;

          const playersByBody = Object.entries(room.players).reduce(
            (acc, [pid, p]) => {
              acc[p.body.id] = p;
              return acc;
            },
            {}
          );

          const pA = playersByBody[pair.bodyA.id];
          const pB = playersByBody[pair.bodyB.id];

          // Força base
          let forceA = IMPACT_FORCE;
          let forceB = IMPACT_FORCE;

          if (pA?.isRigid) {
            forceA *= 2; // Ataca mais forte
            forceB *= 0.5; // Sofre menos
          }
          if (pB?.isRigid) {
            forceB *= 2;
            forceA *= 0.5;
          }

          Body.applyForce(pair.bodyA, pair.bodyA.position, {
            x: directionX * forceA,
            y: directionY * forceA,
          });

          Body.applyForce(pair.bodyB, pair.bodyB.position, {
            x: -directionX * forceB,
            y: -directionY * forceB,
          });

          console.log(
            "💥 Impacto entre jogadores detectado! Modo rígido aplicado se ativado.", {pa: pA?.isRigid, pn: pB?.isRigid}
          );
        }
      }
    });
  });

  rooms[roomId] = room;
}

function applyInput(player, input) {
  const body = player.body;
  const force = 0.0005;      // movimento lateral mais lento
const jumpForce = -0.03; 

  if (input.keys.a) Body.applyForce(body, body.position, { x: -force, y: 0 });
  if (input.keys.d) Body.applyForce(body, body.position, { x: force, y: 0 });
  if (input.keys.w && player.canJump) {
    Body.applyForce(body, body.position, { x: 0, y: jumpForce });
    player.canJump = false;
  }

  // Modo rígido ativado
  player.isRigid = input.keys.space === true;
}

function startRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.round++;
  room.status = "playing";
  console.log(`🚦 Iniciando rodada ${room.round} da sala ${roomId}`);

  for (const id in room.players) {
    const player = room.players[id];
    Body.setPosition(player.body, { x: 0, y: 0 });
    Body.setVelocity(player.body, { x: 0, y: 0 });
    player.alive = true;
    player.canJump = false;
    player.inputQueue = [];
  }

  broadcast(room, {
    type: "start",
    round: room.round,
  });
}

function endRound(roomId, winnerId) {
  const room = rooms[roomId];
  if (!room) return;

  room.status = "paused";

  broadcast(room, {
    type: "roundWinner",
    round: room.round,
    winner: winnerId ?? "draw",
  });

  if (winnerId && winnerId !== "draw") {
    room.scores[winnerId] = (room.scores[winnerId] || 0) + 1;

    broadcast(room, {
      type: "scoreUpdate",
      scores: room.scores,
    });

    if (room.scores[winnerId] >= WINNING_SCORE) {
      broadcast(room, {
        type: "matchWinner",
        winner: winnerId,
        scores: room.scores,
      });
      return;
    }
  }

  setTimeout(() => startRound(roomId), 3000);
}

function tickRoom(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== "playing") return;

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

  for (const id in players) {
  const player = players[id];
  const desiredMass = player.isRigid ? 10 : 1;

  if (player.body.mass !== desiredMass) {
    Body.setMass(player.body, desiredMass);
  }
}

  Engine.update(engine, 1000 / 60);

  for (const id in players) {
    const player = players[id];
    if (player.alive && player.body.position.y > 600) {
      player.alive = false;
      console.log(`💀 Player ${id} caiu`);
    }
  }

  const alivePlayers = Object.entries(players).filter(([_, p]) => p.alive);
  if (alivePlayers.length === 1) {
    const [winnerId] = alivePlayers[0];
    console.log(`🏆 Player ${winnerId} venceu a rodada`);
    endRound(roomId, winnerId);
  } else if (alivePlayers.length === 0) {
    console.log(`⚖️ Rodada empatada`);
    endRound(roomId, "draw");
  }

  const snapshot = Object.entries(players).map(([id, p]) => ({
    id,
    x: p.body.position.x,
    y: p.body.position.y,
    alive: p.alive,
    lastProcessedInput: p.lastProcessedInput ?? 0,
    isRigid: p.isRigid, // << NOVO
  }));

  broadcast(room, {
    type: "snapshot",
    players: snapshot,
    scores: room.scores,
    round: room.round,
  });
}

function broadcast(room, message) {
  const str = JSON.stringify(message);
  for (const id in room.players) {
    const ws = room.players[id].ws;
    if (ws.readyState === 1) {
      ws.send(str);
    }
  }
}

// Tick loop
setInterval(() => {
  for (const roomId in rooms) tickRoom(roomId);
}, TICK_RATE);

// WebSocket connection
wss.on("connection", (ws) => {
  let playerId = uuidv4();
  let roomId = null;

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === "join" && data.match) {
        roomId = `match-${data.match}`;
        if (!rooms[roomId]) createRoom(roomId);
        const room = rooms[roomId];

        const body = Bodies.circle(0, 0, 20, {
          restitution: PLAYER_BOUNCE,
          friction: 0.05,
        });
        Composite.add(room.engine.world, body);

        room.players[playerId] = {
          body,
          inputQueue: [],
          lastProcessedInput: null,
          canJump: false,
          ws,
          alive: true,
          isRigid: false, // << NOVO
        };

        if (!room.scores[playerId]) room.scores[playerId] = 0;
        room.lastActivity = new Date();

        ws.send(
          JSON.stringify({
            type: "welcome",
            id: playerId,
            map: room.platforms,
            round: room.round,
          })
        );

        console.log(`✅ Player ${playerId} entrou na sala ${roomId}`);

        if (
          Object.keys(room.players).length >= MIN_PLAYERS &&
          room.status === "waiting"
        ) {
          startRound(roomId);
        }
      }

      if (data.type === "input" && roomId && rooms[roomId]) {
        const room = rooms[roomId];
        const player = room.players[playerId];
        if (player) {
          player.inputQueue.push(data);
          room.lastActivity = new Date(); // atualiza atividade
        }
      }
    } catch (err) {
      console.error("❌ Erro ao processar mensagem:", err);
    }
  });

  ws.on("close", () => {
    const room = rooms[roomId];
    if (room) {
      Composite.remove(room.engine.world, room.players[playerId]?.body);
      delete room.players[playerId];
      console.log(`⛔ Player ${playerId} saiu da sala ${roomId}`);
    }
  });
});

console.log("🚀 Servidor WebSocket rodando na porta 8080");

// ----------------------------------------
// 🔁 Limpeza automática de salas antigas/inativas
// ----------------------------------------

function cleanupOldRooms() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  for (const roomId in rooms) {
    const room = rooms[roomId];
    const noPlayers = Object.keys(room.players).length === 0;
    const inactiveForTooLong = now - room.lastActivity > INACTIVITY_LIMIT;
    const isOld = room.createdAt < yesterday;

    if (noPlayers && (inactiveForTooLong || isOld)) {
      console.log(`🧹 Limpando sala: ${roomId}`);

      Composite.clear(room.engine.world, false);
      if (room.runner) Runner.stop(room.runner);

      delete rooms[roomId];
    }
  }
}

// Roda a limpeza a cada 5 minutos
setInterval(cleanupOldRooms, 5 * 60 * 1000);

// Executa uma limpeza logo ao iniciar
cleanupOldRooms();

server.listen(8080, () => {
  console.log("🚀 Servidor HTTP e WebSocket rodando na porta 8080");
});