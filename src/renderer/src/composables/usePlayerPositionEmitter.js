// src/renderer/src/composables/usePlayerPositionEmitter.js
import { ref } from 'vue'
import { Room, createLocalAudioTrack } from 'livekit-client'

const PROXIMITY_WS       = import.meta.env.VITE_PROXIMITY_WS
const LIVEKIT_URL        = import.meta.env.VITE_LIVEKIT_URL
const TOKEN_SERVICE_URL  = import.meta.env.VITE_LIVEKIT_TOKEN_SERVICE_URL

export default function usePlayerPositionEmitter() {
  // reactive list for your UI
  const nearbyPlayers = ref([])

  // internal state
  let proximitySocket = null
  let reconnectTimer  = null
  let guid            = null
  let livekitRoom     = null
  let currentRoomId   = null
  let joinedRoom      = false
  let localAudioTrack = null

  const DEBUG = true
  function log(...args) { if (DEBUG) console.log('[usePlayerPositionEmitter]', ...args) }

  /** Called by your UI to set the player’s GUID before connecting */
  function setGuid(playerGuid) {
    guid = playerGuid
  }

  /** Open (or reopen) the proximity WebSocket */
  function connectToProximitySocket() {
    if (!guid) {
      log('Cannot connect: GUID not set')
      return
    }
    if (
      proximitySocket &&
      (proximitySocket.readyState === WebSocket.OPEN ||
       proximitySocket.readyState === WebSocket.CONNECTING)
    ) {
      log('Proximity WS already open')
      return
    }

    proximitySocket = new WebSocket(PROXIMITY_WS)
    proximitySocket.onopen = () => {
      log('Proximity WS: Connected')
      // let the server know your GUID
      proximitySocket.send(JSON.stringify({ guid }))
    }
    proximitySocket.onerror = e => log('Proximity WS: Error', e)
    proximitySocket.onclose = () => {
      log('Proximity WS: Closed, reconnecting in 2s')
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

  /** Join (or switch) your LiveKit room based on current mapId */
  async function joinLivekitRoom(mapId) {
    if (joinedRoom && currentRoomId === mapId) return

    // if changing maps, disconnect first
    if (joinedRoom && currentRoomId !== mapId) {
      try { await livekitRoom.disconnect() }
      catch (e) { log('Error during LiveKit disconnect:', e) }
      joinedRoom = false
      currentRoomId = null
    }

    // fetch a fresh JWT for this guid+room
    let tokenStr
    try {
      const res = await fetch(`${TOKEN_SERVICE_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid, room: String(mapId) }),
      })
      if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`)
      const payload = await res.json()
      log('Token payload:', payload)
      // support either { token: '...' } or { token: { token: '...' } }
      if (typeof payload.token === 'string') {
        tokenStr = payload.token
      } else if (
        payload.token &&
        typeof payload.token.token === 'string'
      ) {
        tokenStr = payload.token.token
      } else {
        throw new Error('Invalid token format')
      }
      log('Using token:', tokenStr)
    } catch (err) {
      log('Token fetch error:', err)
      return
    }

    // create the Room and subscribe to incoming audio tracks
    livekitRoom = new Room()
    livekitRoom.on('trackSubscribed', (track, _, participant) => {
      if (track.kind === 'audio') {
        // Remove previous element if exists
        if (participant._audioElement) {
          participant._audioElement.remove();
        }
        const el = track.attach()
        el.autoplay    = true
        el.playsInline = true
        el.dataset.participantSid = participant.sid
        // hide offscreen
        el.style.position = 'absolute'
        el.style.left     = '-9999px'
        document.body.appendChild(el)
        // Store a reference to the element for later volume control
        participant._audioElement = el
      }
    })
    livekitRoom.on('participantDisconnected', (participant) => {
      if (participant._audioElement) {
        participant._audioElement.remove();
        participant._audioElement = null;
      }
    })

    try {
      // grab your mic, with echo/noise suppression off for cleaner spatial
      localAudioTrack = await createLocalAudioTrack({
        echoCancellation:   false,
        noiseSuppression:   false,
        autoGainControl:    false,
      })
      // connect & publish
      await livekitRoom.connect(LIVEKIT_URL, tokenStr, {
        autoSubscribe: true,
        name: String(guid), // This should match your guid!
        room: String(mapId),
      })
      await livekitRoom.localParticipant.publishTrack(localAudioTrack)
      joinedRoom    = true
      currentRoomId = mapId
      log('LiveKit room connected:', mapId)
    } catch (err) {
      log('LiveKit connection failed:', err)
    }
  }

  /**
   * Apply volume + spatial panning:
   *  - ≤10 yd → vol = 1
   *  - 10–50 yd → linearly fade from 1 → 0
   *  - >50 yd → vol = 0
   */
  function updateAudioVolumes(withinRange, self) {
    if (!joinedRoom || !livekitRoom) return;

    const participantsMap = livekitRoom.participants ?? new Map();
    const participants = Array.from(participantsMap.values());
    participants.forEach(participant => {
      for (const pub of participant.getTrackPublications()) {
        const track = pub.track;
        if (track && track.kind === 'audio') {
          const p = withinRange.find(x => String(x.guid) === participant.identity);
          let vol = 0;
          if (p) {
            if (p.distance <= 10) {
              vol = 1;
            } else if (p.distance < 50) {
              vol = 1 - (p.distance - 10) / 40;
            }
            vol = Math.max(0, Math.min(1, vol));
            if (typeof track.setSpatialPosition === 'function') {
              track.setSpatialPosition(
                p.x - self.x,
                p.y - self.y,
                (p.z || 0) - (self.z || 0),
              );
            }
          } else {
            // Not in range, force volume to 0
            vol = 0;
          }
          log('Setting volume for', participant.identity, 'to', vol);
          if (typeof track.setVolume === 'function') {
            track.setVolume(vol);
          }
          if (participant._audioElement) {
            participant._audioElement.volume = vol;
          }
        }
      }
    });
  }

  /** When new proximity data arrives… */
  async function handleProximityUpdate(data) {
    if (!guid || typeof data !== 'object') return

    // flatten per-map arrays
    const allPlayers = Object.values(data).flat()
    const self = allPlayers.find(p => String(p.guid) === String(guid))
    if (!self) {
      log('Self GUID not found in payload')
      return
    }

    // compute distances for same-map peers
    const nearby = allPlayers
      .filter(p => p.guid !== guid && String(p.map) === String(self.map))
      .map(p => {
        const dx = p.x - self.x
        const dy = p.y - self.y
        const dz = (p.z || 0) - (self.z || 0)
        return { ...p, distance: Math.hypot(dx, dy, dz) }
      })
      .filter(p => p.distance <= 50)

    nearbyPlayers.value = nearby
    log('Nearby players:', nearby)

    // always ensure you’re in the right room
    await joinLivekitRoom(self.map)
    // then update volumes
    if (joinedRoom) {
      updateAudioVolumes(nearby, self)
    }
  }

  /** Call this when your own position changes */
  function updateSelfPosition(newX, newY, newZ) {
    const self = {
      guid,
      x: newX,
      y: newY,
      z: newZ,
      map: currentRoomId,
    };
    updateAudioVolumes(nearbyPlayers.value, self);
  }

  /** Expose a mic-mute toggle for your UI */
  function toggleMic(muted) {
    if (!localAudioTrack) return
    muted ? localAudioTrack.mute() : localAudioTrack.unmute()
  }

  /** Clean up WS & LiveKit on unmount */
  function dispose() {
    clearTimeout(reconnectTimer)
    proximitySocket?.close()
    livekitRoom?.disconnect()
    proximitySocket = null
    livekitRoom    = null
    joinedRoom     = false
  }

  return {
    setGuid,
    connectToProximitySocket,
    dispose,
    nearbyPlayers,
    toggleMic,
    updateSelfPosition,
  }
}