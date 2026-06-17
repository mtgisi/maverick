// Read-only Docker status via the docker socket (over HTTP on a unix socket).
// Gated by ENABLE_DOCKER_TOOL=true AND the socket being mounted read-only in compose.
// No start/stop/restart — status only. Fails closed.
const http = require('http');
const { dockerTool } = require('../config');

const SOCKET = '/var/run/docker.sock';

function dockerGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path, method: 'GET' }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`docker ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function status() {
  if (!dockerTool) return { enabled: false, containers: [] };
  const list = await dockerGet('/containers/json?all=1');
  const containers = list.map(c => ({
    name: (c.Names && c.Names[0] || '').replace(/^\//, ''),
    image: c.Image,
    state: c.State,         // running | exited | ...
    status: c.Status,       // "Up 3 hours" / "Exited (0) ..."
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { enabled: true, count: containers.length, containers };
}

module.exports = { status, enabled: () => dockerTool };
