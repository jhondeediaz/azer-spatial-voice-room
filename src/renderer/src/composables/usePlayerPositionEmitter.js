// src/renderer/src/composables/usePlayerPositionEmitter.js
import { ref } from 'vue'
import { Room, createLocalAudioTrack } from 'livekit-client'

const PROXIMITY_WS      = import.meta.env.VITE_PROXIMITY_WS
const LIVEKIT_URL       = import.meta.env.VITE_LIVEKIT_URL
const TOKEN_SERVICE_URL = import.meta.env.VITE_LIVEKIT_TOKEN_SERVICE_URL

export default function usePlayerPositionEmitter() {
  const nearbyPlayers = ref([])   // exposed to UI

  // internal state
  let proximitySocket = null
  let reconnectTimer  = null
  let guid            = null
  let livekitRoom     = null
  let currentRoomId   = null
  let joinedRoom      = false

  const DEBUG = true
  function log(...args) {
    if (DEBUG) console.log('[usePlayerPositionEmitter]', ...args)
  }

  // called by UI to set the GUID
  function setGuid(playerGuid) {
    guid = playerGuid
  }

  // open or reopen proximity WS
  function connectToProximitySocket() {
    if (!guid) {
      log('Cannot connect: GUID not set')
      return
    }
    if (proximitySocket &&
        (proximitySocket.readyState === WebSocket.OPEN ||
         proximitySocket.readyState === WebSocket.CONNECTING)
    ) {
      log('Proximity WS already open')
      return
    }

    proximitySocket = new WebSocket(PROXIMITY_WS)
    proximitySocket.onopen = () => {
      log('Proximity WS: Connected')
      proximitySocket.send(JSON.stringify({ guid }))
    }
    proximitySocket.onerror = e => log('Proximity WS: Error', e)
    proximitySocket.onclose = () => {
      log('Proximity WS: Closed, reconnect in 2s')
      reconnectTimer = setTimeout(connectToProximitySocket, 2000)
    }
    proximitySocket.onmessage = e => {
      let data
      try {
        data = JSON.parse(e.data)
      } catch {
        log('Failed to parse proximity payload:', e.data)
        return
      }
      handleProximityUpdate(data)
    }
  }

  // join or switch LiveKit room based on mapId
  async function joinLivekitRoom(mapId) {
    if (joinedRoom && currentRoomId === mapId) return;

    // if switching, disconnect first
    if (joinedRoom && currentRoomId !== mapId) {
      try {
        await livekitRoom.disconnect();
      } catch (e) {
        log('Error disconnect LiveKit:', e);
      }
      joinedRoom = false;
      currentRoomId = null;
    }

    // fetch JWT
    let tokenStr;
    try {
      const res = await fetch(`${TOKEN_SERVICE_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid, room: String(mapId) }),
      });
      if (!res.ok) throw new Error(`token fetch failed: ${res.status} ${res.statusText}`);
      const payload = await res.json();
      // debug entire payload
      log('Token payload:', payload);
      // extract string
      if (typeof payload.token === 'string') {
        tokenStr = payload.token;
      } else if (payload.token && typeof payload.token.token === 'string') {
        tokenStr = payload.token.token;
      } else {
        console.error('Invalid token payload:', payload);
        throw new Error('Invalid token format');
      }
      log('Using token:', tokenStr);
    } catch (err) {
      log('Token fetch error:', err);
      return;
    }

    // connect and publish
    livekitRoom = new Room();
    livekitRoom.on('trackSubscribed', (track, pub, participant) => {
      if (track.kind === 'audio') {
        const el = track.attach();
        el.autoplay = true;
        el.playsInline = true;
        el.dataset.participantSid = participant.sid;
        el.style.position = 'absolute';
        el.style.left = '-9999px';
        document.body.appendChild(el);
      }
    });

    try {
      const localTrack = await createLocalAudioTrack();
      await livekitRoom.connect(LIVEKIT_URL, tokenStr, {
        autoSubscribe: true,
        name: String(guid),
        room: String(mapId),
      });
      await livekitRoom.localParticipant.publishTrack(localTrack);
      joinedRoom = true;
      currentRoomId = mapId;
      log('LiveKit room connected:', mapId);
    } catch (err) {
      log('LiveKit connection failed:', err);
    }
  }

  // handle proximity updates
  async function handleProximityUpdate(data) {
    if (!guid || typeof data !== 'object') return

    const allPlayers = Object.values(data).flat()
    const self = allPlayers.find(p => String(p.guid) === String(guid))
    if (!self) {
      log('Self GUID not found in payload')
      return
    }

    // compute distances on same map
    const nearby = allPlayers
      .filter(p => p.guid !== guid && String(p.map) === String(self.map))
      .map(p => {
        const dx = p.x - self.x, dy = p.y - self.y, dz = (p.z||0) - (self.z||0)
        const distance = Math.sqrt(dx*dx + dy*dy + dz*dz)
        return { ...p, distance }
      })
      .filter(p => p.distance <= 10)

    nearbyPlayers.value = nearby
    log('Nearby players:', nearby)

    if (nearby.length > 0) {
      await joinLivekitRoom(self.map)
      if (joinedRoom) {
        // update volumes/spatial positions
        nearby.forEach(p => {
          const participant = livekitRoom.getParticipantByIdentity(String(p.guid))
          if (!participant) return
          participant.audioTracks.forEach(pub => {
            const track = pub.track
            if (track && track.kind === 'audio') {
              const vol = Math.max(0, 1 - p.distance / 10)
              track.setVolume(vol)
              track.setSpatialPosition(
                p.x - self.x,
                p.y - self.y,
                (p.z || 0) - (self.z || 0)
              )
            }
          })
        })
      }
    }
  }

  // cleanup
  function dispose() {
    clearTimeout(reconnectTimer)
    if (proximitySocket) proximitySocket.close()
    if (livekitRoom) livekitRoom.disconnect()
  }

  return {
    setGuid,
    connectToProximitySocket,
    dispose,
    nearbyPlayers,
  }
}