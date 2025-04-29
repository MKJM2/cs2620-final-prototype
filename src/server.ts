// src/server.ts
import fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyIO from "fastify-socket.io";
import fastifyStatic from "@fastify/static";
import path from "path";
import { fileURLToPath } from "url";
import { TextOperation } from "./ot";
import type {
  UserInfo,
  ClientPushMsg,
  ClientPullMsg,
  ServerAckMsg,
  ServerErrorMsg,
  ServerUpdateMsg,
  ServerHistoryMsg,
  ServerInitialStateMsg,
  ServerYourIdentityMsg,
  ServerCurrentUsersMsg,
  ServerUserJoinedMsg,
  ServerUserLeftMsg
} from "./types";
import { Socket } from "socket.io";

// Get __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("Starting OT Server...");

// --- User Name Generation ---
const adjectives = [
  "Agile", "Brave", "Calm", "Dandy", "Eager", "Fancy", "Gentle", "Happy",
  "Jolly", "Kind", "Lively", "Merry", "Nice", "Orange", "Proud",
  "Quirky", "Vivid", "Witty", "Anonymous",
];
const animals = [
  "Badger", "Cat", "Dog", "Elephant", "Fox", "Giraffe", "Hippo",
  "Iguana", "Jaguar", "Koala", "Lemur", "Narwhal", "Octopus",
  "Penguin", "Quokka", "Rabbit", "Tiger", "Walrus", "Zebra",
];

function generateFunnyName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  return `${adj} ${animal}`;
}

// --- OT Server State ---
let documentState = "";
let currentRevision = 0;
// History of applied operations (each op takes state from rev n to rev n+1)
const operationHistory: TextOperation[] = [];

// -- User Presence State ---
const connectedUsers = new Map<string, UserInfo>();

// --- Fastify Server Setup ---
const app = fastify();

// 1. Register CORS so that /socket.io polling requests have proper headers.
app.register(fastifyCors, { origin: "*" });

// 2. Register Socket.IO. Note: Its default endpoint is '/socket.io'
app.register(fastifyIO, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// 3. Register static asset serving for your public assets under '/public'.
// This prevents a catch-all route serving every path (like /socket.io).
const publicDir = path.resolve(__dirname, "../public");
app.register(fastifyStatic, {
  root: publicDir,
  prefix: "/public", // e.g. /public/client.js, /public/style.css, etc.
});

// Serve index.html at the root path.
app.get("/", (_req, reply) => {
  reply.sendFile("index.html");
});

app.ready().then(() => {
  app.io.on("connection", (socket: Socket) => {
    console.log(`Client connected: ${socket.id}`);

    // --- User Presence Handling ---
    // 1. Assign a name and store user info
    const username = generateFunnyName();
    const userInfo: UserInfo = { id: socket.id, username };
    connectedUsers.set(socket.id, userInfo);
    // Store on socket data for easy access on disconnect
    socket.data.userInfo = userInfo;
    console.log(`Assigned name "${username}" to ${socket.id}`);

    // 2. Send the client their identity
    const identityMsg: ServerYourIdentityMsg = { user: userInfo };
    socket.emit("your_identity", identityMsg);

    // 3. Send the new client the list of *all* current users (including themselves)
    const allUsers = Array.from(connectedUsers.values());
    const currentUsersMsg: ServerCurrentUsersMsg = { users: allUsers };
    socket.emit("current_users", currentUsersMsg);
    console.log(`Sent current user list (${allUsers.length}) to ${socket.id}`);

    // 4. Broadcast to *other* clients that a new user joined
    const joinedMsg: ServerUserJoinedMsg = { user: userInfo };
    socket.broadcast.emit("user_joined", joinedMsg);
    console.log(`Broadcast user_joined for ${socket.id} (${username})`);

    // 4a. Send the initial document state.
    const initialStateMsg: ServerInitialStateMsg = {
      doc: documentState,
      revision: currentRevision,
    };
    socket.emit("initial_state", initialStateMsg);
    console.log(`Sent initial state (rev ${currentRevision}) to ${socket.id}`);

    // 4b. Handle client 'push' events.
    socket.on("push", (msg: ClientPushMsg) => {
      console.log(
        `Received push from ${socket.id} based on their rev ${msg.revision}`
      );
      try {
        const clientOp = TextOperation.fromJSON(msg.op);
        const clientRevision = msg.revision;

        if (clientRevision < 0 || clientRevision > currentRevision) {
          console.error(
            `Invalid revision ${clientRevision} from ${socket.id}. Server revision is ${currentRevision}.`
          );
          const errorMsg: ServerErrorMsg = {
            message: `Invalid revision ${clientRevision}. Server is at ${currentRevision}. Please pull.`,
          };
          socket.emit("error", errorMsg);
          return;
        }

        // Transform client's op against concurrent operations.
        const concurrentOps = operationHistory.slice(clientRevision);
        let transformedClientOp = clientOp;
        for (const historicalOp of concurrentOps) {
          if (
            transformedClientOp.baseLength !== historicalOp.baseLength
          ) {
            console.error(
              `History Inconsistency: Op ${transformedClientOp.toString()} (base ${transformedClientOp.baseLength}) ` +
              `cannot be transformed against historical op ${historicalOp.toString()} (base ${historicalOp.baseLength}) ` +
              `at revision ${clientRevision + concurrentOps.indexOf(historicalOp)}`
            );
            throw new Error(
              "Server history inconsistency detected during transform."
            );
          }
          [transformedClientOp] = TextOperation.transform(
            transformedClientOp,
            historicalOp
          );
        }

        // Apply the transformed op.
        console.log(
          `Applying transformed op from ${socket.id}: ${transformedClientOp.toString()}`
        );
        documentState = transformedClientOp.apply(documentState);
        currentRevision++;
        operationHistory.push(transformedClientOp);

        // ACK back to the originator.
        const ackMsg: ServerAckMsg = { revision: currentRevision };
        socket.emit("ack", ackMsg);
        console.log(
          `Sent ack (new rev ${currentRevision}) to ${socket.id}`
        );

        // Broadcast update to all other clients.
        const updateMsg: ServerUpdateMsg = {
          revision: currentRevision,
          op: transformedClientOp.toJSON(),
        };
        socket.broadcast.emit("update", updateMsg);
        console.log(
          `Broadcast update (rev ${currentRevision}) to other clients`
        );
      } catch (error: any) {
        console.error(
          `Error processing push from ${socket.id}:`,
          error.message || error,
          "Message:",
          msg
        );
        const errorMsg: ServerErrorMsg = {
          message: `Failed to process operation: ${error.message || "Unknown error"}`,
        };
        socket.emit("error", errorMsg);
      }
    });

    // 4c. Handle client 'pull' events.
    socket.on("pull", (msg: ClientPullMsg) => {
      console.log(
        `Received pull from ${socket.id} requesting ops since rev ${msg.revision}`
      );
      const clientRevision = msg.revision;

      if (clientRevision < 0 || clientRevision > currentRevision) {
        console.error(
          `Invalid revision ${clientRevision} in pull request from ${socket.id}. ` +
          `Server revision is ${currentRevision}. Sending full history.`
        );
        const historyToSend = operationHistory.map((op) => op.toJSON());
        const historyMsg: ServerHistoryMsg = {
          startRevision: 1,
          ops: historyToSend,
          currentRevision: currentRevision,
          currentDocState: documentState,
        };
        socket.emit("history", historyMsg);
        console.warn(
          `Sent full history due to invalid pull revision from ${socket.id}`
        );
        return;
      }

      const opsToSend = operationHistory
        .slice(clientRevision)
        .map((op) => op.toJSON());

      const historyMsg: ServerHistoryMsg = {
        startRevision: clientRevision + 1,
        ops: opsToSend,
        currentRevision: currentRevision,
        currentDocState: documentState,
      };
      socket.emit("history", historyMsg);
      console.log(
        `Sent ${opsToSend.length} ops (rev ${clientRevision + 1} to ${currentRevision}) to ${socket.id}`
      );
    });

    // 4d. Handle disconnect.
    socket.on("disconnect", (reason: any) => {
      const leavingUser = socket.data.userInfo as UserInfo | undefined;
      const username = leavingUser?.username || "Unknown User";
      console.log(
        `Client disconnected: ${socket.id} (${username}). Reason: ${reason}`
      );

      // Remove user from tracking
      if (connectedUsers.delete(socket.id)) {
        // Broadcast that the user left
        const leftMsg: ServerUserLeftMsg = { userId: socket.id };
        socket.broadcast.emit("user_left", leftMsg);
        console.log(`Broadcast user_left for ${socket.id} (${username})`);
      } else {
        console.warn(`User ${socket.id} disconnected but was not found in connectedUsers map.`);
      }
    });
  });
});

// --- Start the Fastify Server ---
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
app.listen({ port: Number(PORT), host: String(HOST) }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Collaborative Editor server running at ${address}`);
});
