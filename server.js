const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({ storage });

app.use(express.static("public"));
app.use("/files", express.static(uploadDir));
app.use(express.json());

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
  // Announce to others that a new peer has joined
  socket.broadcast.emit("peer_joined", socket.id);

  // Relay signaling data (offer/answer/ice candidates) between peers
  socket.on("signal", (data) => {
    io.to(data.to).emit("signal", {
      from: socket.id,
      signal: data.signal,
    });
  });

  // Announce peer left
  socket.on("disconnect", () => {
    socket.broadcast.emit("peer_left", socket.id);
  });
});

// auto cleanup every hour (files older than 24h)
setInterval(() => {
  const now = Date.now();

  fs.readdirSync(uploadDir).forEach((f) => {
    const p = path.join(uploadDir, f);
    const stat = fs.statSync(p);

    if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(p);
      io.emit("file_deleted", f);
    }
  });
}, 3600000);

server.listen(3000, () => {
  console.log("LAN Share running on http://localhost:3000");
});
