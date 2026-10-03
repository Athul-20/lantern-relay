# Lantern Relay

Lantern Relay is a cooperative light puzzle with solo practice and private multiplayer rooms for 2–6 players. The same beam simulator powers solo play and the authoritative room server. Room actions are validated on the server and broadcast to all connected players.

## Run locally

1. Install Node.js 22.6 or newer (Node 24 is recommended; the server uses Node's built-in TypeScript stripping).
2. In this folder, run `npm install` once.
3. Run `npm run dev` and open `http://localhost:4173`.

The local server serves the built web app and the room WebSocket endpoint from the same origin. Solo practice continues to work if that server is unavailable.

## Multiplayer play-test

- Create a room in one tab, enter a name, then copy the invite link or code.
- Open that link in other tabs or devices on the same network. A different tab can join by code.
- Duplicate names receive a number automatically. Colors are assigned in join order.
- The host starts once at least two players are connected. The host controls restart, next level, and room end.
- To test on another device on the same Wi-Fi, open `http://<computer-LAN-address>:4173` there. Do not use `localhost` on the second device; it points back to that device.

## Exact play-test steps

1. **Two devices:** Open the host address below on device one. Create a room. On device two, open the copied invite link (or enter the four-letter code). Confirm both names and red/blue colors appear, then have the host start. Turn each player's mirror and confirm both boards update.
2. **Four tabs:** Create a fresh room in tab one. Join the same link from tabs two, three, and four. Use the same name in two tabs to confirm it becomes `Name (2)`. Confirm the lobby shows red, blue, yellow, and green, and only the host can start.
3. **Disconnect and rejoin:** Start a two-player room, then reload tab two. It should reconnect within 60 seconds, regain its original color, and return to the current board. While it reconnects, tab one should show the waiting pause. To check the timeout choice, leave one player disconnected for 60 seconds; the host then sees **Continue without them** and **End room**.
4. **Full room:** Join with six tabs and confirm the lobby shows all six colors. Try joining from a seventh tab; it should show `This room is full (6 players).`
5. **Wrong code:** On the Join room form, enter `ZZZZ`. It should show `Room not found. Check the code and try again.`

For two devices on the same Wi-Fi, use the host computer's LAN address, currently `http://192.168.1.6:4173`. `localhost` on another device points back to that device.

## Build

Run `npm run build`. The static client is written to `dist/`; multiplayer requires the Node server in `server/index.ts` to remain available. Deployment has not been configured.
