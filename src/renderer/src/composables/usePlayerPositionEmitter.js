// src/renderer/src/composables/usePlayerPositionEmitter.js
import { ref } from 'vue'
import { Room, createLocalAudioTrack } from 'livekit-client'

const PROXIMITY_WS      = import.meta.env.VITE_PROXIMITY_WS
const LIVEKIT_URL       = import.meta.env.VITE_LIVEKIT_URL
const TOKEN_SERVICE_URL = import.meta.env.VITE_LIVEKIT_TOKEN_SERVICE_URL

export default function usePlayerPositionEmitter() {
  // reactive array for your UI
  const nearbyPlayers = ref([])

  // internal state
  let proximitySocket   = null
  let reconnectTimer    = null
  let guid              = null
  let livekitRoom       = null
  let currentRoomId     = null
  let joinedRoom        = false
  let localAudioTrack   = null  // store track for mute/unmute

  const DEBUG = true
  function log(...args) {
    if (DEBUG) console.log('[usePlayerPositionEmitter]', ...args)
  }

  /** Register the player's GUID from the UI */
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
      // notify server of your GUID
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

  /** Join (or switch) a LiveKit room named by mapId */
  async function joinLivekitRoom(mapId) {
    if (joinedRoom && currentRoomId === mapId) {
      return
    }

    // if switching maps, cleanly disconnect first
    if (joinedRoom && currentRoomId !== mapId) {
      try {
        await livekitRoom.disconnect()
      } catch (e) {
        log('Error during LiveKit disconnect:', e)
      }
      joinedRoom = false
      currentRoomId = null
    }

    // fetch a fresh JWT from your token service
    let tokenStr
    try {
      const res = await fetch(`${TOKEN_SERVICE_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid, room: String(mapId) }),
      })
      if (!res.ok) {
        throw new Error(`Token fetch failed: ${res.status} ${res.statusText}`)
      }
      const payload = await res.json()
      log('Token payload:', payload)
      if (typeof payload.token === 'string') {
        tokenStr = payload.token
      } else if (payload.token && typeof payload.token.token === 'string') {
        tokenStr = payload.token.token
      } else {
        throw new Error('Invalid token format')
      }
      log('Using token:', tokenStr)
    } catch (err) {
      log('Token fetch error:', err)
      return
    }

    // set up LiveKit Room
    livekitRoom = new Room()
    livekitRoom.on('trackSubscribed', (track, pub, participant) => {
      if (track.kind === 'audio') {
        const el = track.attach()
        el.autoplay = true
        el.playsInline = true
        el.dataset.participantSid = participant.sid
        el.style.position = 'absolute'
        el.style.left = '-9999px'
        document.body.appendChild(el)
      }
    })

    try {
      // create and publish our local mic track
      localAudioTrack = await createLocalAudioTrack()
      await livekitRoom.connect(LIVEKIT_URL, tokenStr, {
        autoSubscribe: true,
        name: String(guid),
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
   * Adjust volumes & spatial positions for tracks in `withinRange`.
   * - 0–10 yd => full volume
   * - 10–50 yd => linearly ramp 1→0
   * - ≥50 yd => silent
   */
  function updateAudioVolumes(withinRange, self = {}) {
    if (!Array.isArray(withinRange)) {
      log('updateAudioVolumes skipped, invalid withinRange:', withinRange)
      return
    }
    withinRange.forEach(p => {
      const participant = livekitRoom.getParticipantByIdentity(String(p.guid))
      if (!participant) return

      // compute ramp: <=10 →1, 10–50 → (50 - d)/40, >=50 →0
      let vol = 0
      if (p.distance <= 10) {
        vol = 1
      } else if (p.distance < 50) {
        vol = (50 - p.distance) / 40
      }

      // only iterate if audioTracks exist and have forEach
      const pubs = participant.audioTracks
      if (!pubs || typeof pubs.forEach !== 'function') {
        log('no audioTracks to update for', participant.sid)
      } else {
        pubs.forEach(pub => {
          const track = pub.track
          if (track && track.kind === 'audio') {
            track.setVolume(vol)
            track.setSpatialPosition(
              p.x - self.x,
              p.y - self.y,
              (p.z || 0) - (self.z || 0)
            )
          }
        })
      }
    })
  }

  /** Handle each incoming proximity update */
  async function handleProximityUpdate(data) {
    if (!guid || typeof data !== 'object') {
      return
    }

    // flatten by map
    const allPlayers = Object.values(data).flat()
    const self       = allPlayers.find(p => String(p.guid) === String(guid))
    if (!self) {
      log('Self GUID not found in payload')
      return
    }

    // compute distances to all same-map players
    const nearby = allPlayers
      .filter(p => p.guid !== guid && String(p.map) === String(self.map))
      .map(p => {
        const dx = p.x - self.x
        const dy = p.y - self.y
        const dz = (p.z || 0) - (self.z || 0)
        const distance = Math.sqrt(dx*dx + dy*dy + dz*dz)
        return { ...p, distance }
      })
      .filter(p => p.distance <= 50)

    nearbyPlayers.value = nearby
    log('Nearby players:', nearby)

    if (nearby.length > 0) {
      await joinLivekitRoom(self.map)
      if (joinedRoom) {
        updateAudioVolumes(nearby, self)
      }
    }
  }

  /** Mute or unmute our own mic track */
  function toggleMic(muted) {
    if (localAudioTrack) {
      localAudioTrack.setEnabled(!muted)
    }
  }

  /** Clean up websocket & LiveKit connections */
  function dispose() {
    clearTimeout(reconnectTimer)
    if (proximitySocket) {
      proximitySocket.close()
      proximitySocket = null
    }
    if (livekitRoom) {
      livekitRoom.disconnect()
      livekitRoom = null
    }
  }

  return {
    setGuid,
    connectToProximitySocket,
    dispose,
    nearbyPlayers,
    toggleMic,
  }
}