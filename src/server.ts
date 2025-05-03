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
import { randomUUID } from "crypto";

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

// --- Multi-document state ---
type DocumentData = { content: string; revision: number; history: TextOperation[] };
const documents = new Map<string, DocumentData>();
// Prepopulate default showcase document
const showcaseId = "showcase";
const showcaseContent = `# COMPSCI 2620: Final Project Showcase

Welcome to **BLADE** — a fast, collaborative Markdown editor with real-time _math typesetting_! 🚀

---

## Features at a Glance
- **Live Collaboration**: Edit documents together in real time
- **Markdown**: _Italics_, **bold**, \`inline code\`, lists, links, and more
- **Math Support**: Beautiful LaTeX equations, inline and block
- [Links! E.g., click here to visit this project's landing page](/)
- Numbered list:
  1. First item
  2. Second item

---

## Math Typesetting Power

Inline math: $\\displaystyle \\lim_{x \\to 0} \\frac{\\sin x}{x} = 1$

Block math:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

And the **Navier–Stokes equation** (incompressible flow):

$$
\\frac{\\partial \\mathbf{u}}{\\partial t} + (\\mathbf{u} \\cdot \\nabla) \\mathbf{u} = -\\nabla p + \\nu \\nabla^2 \\mathbf{u} + \\mathbf{f}
$$

---

### About This Project

This project was created for the final project of **COMPSCI 2620** (taught by Jim Waldo).

**Authors:** Michal Kurek & Natnael Teshome (Group 2)

We extend our heartfelt thanks to the entire teaching staff for an amazing semester and for supporting us during the SEAS Design Fair!
`;
documents.set(showcaseId, { content: showcaseContent, revision: 0, history: [] });

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

// Serve dashboard at root.
app.get("/", (_req, reply) => {
  reply.sendFile("dashboard.html");
});

// Serve editor shell for a specific document.
app.get("/docs/:docId", (req, reply) => {
  reply.sendFile("index.html");
});

// Create a new document.
app.post("/docs", async (req, reply) => {
  const docId = randomUUID();
  documents.set(docId, { content: "", revision: 0, history: [] });
  reply.code(201).send({ id: docId });
});

app.ready().then(() => {
  app.io.on("connection", (socket: Socket) => {
    // Determine document ID from handshake and join room
    const raw = socket.handshake.query.docId;
    console.log(`Client ${socket.id} attempting to connect to document ${raw}. Checking if document exists...`)
    const docId = typeof raw === "string" && documents.has(raw) ? raw : showcaseId;
    socket.join(docId);
    const doc = documents.get(docId)!;
    console.log(`Client ${socket.id} connected to document ${docId}`);

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
      doc: doc.content,
      revision: doc.revision,
    };
    socket.emit("initial_state", initialStateMsg);
    console.log(`Sent initial state (rev ${doc.revision}) to ${socket.id}`);

    // 4b. Handle client 'push' events.
    socket.on("push", (msg: ClientPushMsg) => {
      console.log(
        `Received push from ${socket.id} based on their rev ${msg.revision}`
      );
      try {
        const clientOp = TextOperation.fromJSON(msg.op);
        const clientRevision = msg.revision;

        if (clientRevision < 0 || clientRevision > doc.revision) {
          console.error(
            `Invalid revision ${clientRevision} from ${socket.id}. Server revision is ${doc.revision}.`
          );
          const errorMsg: ServerErrorMsg = {
            message: `Invalid revision ${clientRevision}. Server is at ${doc.revision}. Please pull.`,
          };
          socket.emit("error", errorMsg);
          return;
        }

        // Transform client's op against concurrent operations.
        const concurrentOps = doc.history.slice(clientRevision);
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
        doc.content = transformedClientOp.apply(doc.content);
        doc.revision++;
        doc.history.push(transformedClientOp);

        // ACK back to the originator.
        const ackMsg: ServerAckMsg = { revision: doc.revision };
        socket.emit("ack", ackMsg);
        console.log(
          `Sent ack (new rev ${doc.revision}) to ${socket.id}`
        );

        // Broadcast update to all other clients.
        const updateMsg: ServerUpdateMsg = {
          revision: doc.revision,
          op: transformedClientOp.toJSON(),
        };
        socket.to(docId).emit("update", updateMsg);
        console.log(
          `Broadcast update (rev ${doc.revision}) to other clients`
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

      if (clientRevision < 0 || clientRevision > doc.revision) {
        console.error(
          `Invalid revision ${clientRevision} in pull request from ${socket.id}. ` +
          `Server revision is ${doc.revision}. Sending full history.`
        );
        const historyToSend = doc.history.map((op) => op.toJSON());
        const historyMsg: ServerHistoryMsg = {
          startRevision: 1,
          ops: historyToSend,
          currentRevision: doc.revision,
          currentDocState: doc.content,
        };
        socket.emit("history", historyMsg);
        console.warn(
          `Sent full history due to invalid pull revision from ${socket.id}`
        );
        return;
      }

      const opsToSend = doc.history
        .slice(clientRevision)
        .map((op) => op.toJSON());

      const historyMsg: ServerHistoryMsg = {
        startRevision: clientRevision + 1,
        ops: opsToSend,
        currentRevision: doc.revision,
        currentDocState: doc.content,
      };
      socket.emit("history", historyMsg);
      console.log(
        `Sent ${opsToSend.length} ops (rev ${clientRevision + 1} to ${doc.revision}) to ${socket.id}`
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
