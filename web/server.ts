import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { Server as SocketIOServer } from "socket.io";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  const io = new SocketIOServer(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    path: "/api/socketio",
  });

  // Store globally so API routes can broadcast events
  (globalThis as Record<string, unknown>).__socketIO = io;

  server.listen(port, () => {
    console.log(`> Prana ready on http://localhost:${port}`);
    console.log(`> Socket.IO on ws://localhost:${port}/api/socketio`);
  });
});
