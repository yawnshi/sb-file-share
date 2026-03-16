const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const uploadDir = path.join(__dirname, "uploads");
const sessionsFile = path.join(__dirname, "sessions.json");

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(sessionsFile))
  fs.writeFileSync(sessionsFile, JSON.stringify([]));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({ storage });

app.use(express.static("public"));
app.use("/files", express.static(uploadDir));
app.use(express.json());

// --- Session File Helpers ---
function getSessions() {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile, "utf-8"));
  } catch (e) {
    return [];
  }
}

function saveSession(code) {
  const sessions = getSessions();
  if (!sessions.find((s) => s.code === code)) {
    // Store object with creation timestamp
    sessions.push({ code, timestamp: Date.now() });
    fs.writeFileSync(sessionsFile, JSON.stringify(sessions));
  }
}

function listFiles() {
  return fs.readdirSync(uploadDir).map((f) => ({
    name: f.split("-").slice(1).join("-"),
    url: "/files/" + f,
    file: f,
  }));
}

app.get("/list", (req, res) => {
  res.json(listFiles());
});

app.post("/upload", upload.single("file"), (req, res) => {
  const file = req.file;

  const info = {
    name: file.originalname,
    url: "/files/" + file.filename,
    file: file.filename,
  };

  io.emit("new_file", info);
  res.json({ ok: true });
});

app.delete("/delete/:file", (req, res) => {
  const f = req.params.file;
  const p = path.join(uploadDir, f);

  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    io.emit("file_deleted", f);
  }

  res.json({ ok: true });
});

// --- WebRTC Signaling ---
io.on("connection", (socket) => {
  // Auto-generate a new unique room/session
  socket.on("create_room", (callback) => {
    let code;
    const sessions = getSessions();
    // Generate 6-character hex code and ensure no clashes
    do {
      code = crypto.randomBytes(3).toString("hex").toUpperCase();
    } while (sessions.some((s) => s.code === code));

    saveSession(code);
    socket.join(code);
    socket.room = code;

    // Calculate expiration (24 hours from now)
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

    if (typeof callback === "function") callback({ code, expiresAt });
  });

  // Join a specific room based on the code validation
  socket.on("join_room", (roomCode, callback) => {
    const sessions = getSessions();
    const session = sessions.find((s) => s.code === roomCode);

    if (session) {
      socket.join(roomCode);
      socket.room = roomCode; // Store room on the socket session
      // Announce to others IN THE SAME ROOM that a new peer has joined
      socket.to(roomCode).emit("peer_joined", socket.id);

      // Calculate expiration based on original creation time
      const expiresAt = session.timestamp + 24 * 60 * 60 * 1000;

      if (typeof callback === "function")
        callback({ success: true, expiresAt });
    } else {
      if (typeof callback === "function")
        callback({
          success: false,
          message: "Invalid session code! Session does not exist.",
        });
    }
  });

  // Client manually leaves the room
  socket.on("leave_room", () => {
    if (socket.room) {
      socket.leave(socket.room);
      socket.to(socket.room).emit("peer_left", socket.id);
      socket.room = null;
    }
  });

  // Relay signaling data (offer/answer/ice candidates) between peers
  socket.on("signal", (data) => {
    io.to(data.to).emit("signal", {
      from: socket.id,
      signal: data.signal,
    });
  });

  // Announce peer left on actual disconnect
  socket.on("disconnect", () => {
    if (socket.room) {
      socket.to(socket.room).emit("peer_left", socket.id);
    }
  });
});

// auto cleanup every hour (files & sessions older than 24h)
setInterval(() => {
  const now = Date.now();

  // 1. Cleanup Files
  try {
    fs.readdirSync(uploadDir).forEach((f) => {
      const p = path.join(uploadDir, f);
      const stat = fs.statSync(p);

      if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
        fs.unlinkSync(p);
        io.emit("file_deleted", f);
      }
    });
  } catch (e) {
    console.error("File cleanup error", e);
  }

  // 2. Cleanup Old Sessions
  try {
    const sessions = getSessions();
    const validSessions = sessions.filter(
      (s) => now - s.timestamp < 24 * 60 * 60 * 1000,
    );

    // Only rewrite if we actually removed some old sessions
    if (sessions.length !== validSessions.length) {
      fs.writeFileSync(sessionsFile, JSON.stringify(validSessions));
    }
  } catch (e) {
    console.error("Session cleanup error", e);
  }
}, 3600000);

server.listen(3000, () => {
  console.log("LAN Share running on http://localhost:3000");
});
