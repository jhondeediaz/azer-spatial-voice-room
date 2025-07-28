// src/renderer/src/composables/usePlayerPositionEmitter.js
import { ref } from 'vue'
import { Room, createLocalAudioTrack } from 'livekit-client'

const PROXIMITY_WS      = import.meta.env.VITE_PROXIMITY_WS
const LIVEKIT_URL       = import.meta.env.VITE_LIVEKIT_URL
const TOKEN_SERVICE_URL = import.meta.env.VITE_LIVEKIT_TOKEN_SERVICE_URL

export default function usePlayerPositionEmitter() {
  // reactive list for the UI
  const nearbyPlayers = ref([])

  // internal state
  let proximitySocket   = null
  let reconnectTimer    = null
  let guid              = null
  let livekitRoom       = null
  let currentRoomId     = null
  let joinedRoom        = false
  let localAudioTrack   = null

  const DEBUG = true
  function log(...args) {
    if (DEBUG) console.log('[usePlayerPositionEmitter]', ...args)
  }

  /** Store the player’s GUID from UI */
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

  /** Join or switch to a LiveKit room named by mapId */
  async function joinLivekitRoom(mapId) {
    if (joinedRoom && currentRoomId === mapId) return

    if (joinedRoom && currentRoomId !== mapId) {
      try {
        await livekitRoom.disconnect()
      } catch (e) {
        log('Error during LiveKit disconnect:', e)
      }
      joinedRoom    = false
      currentRoomId = null
    }

    // fetch JWT
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

    // setup room & subscribe
    livekitRoom = new Room()
    livekitRoom.on('trackSubscribed', (track, _, participant) => {
      if (track.kind === 'audio') {
        const el = track.attach()
        el.autoplay    = true
        el.playsInline = true
        el.dataset.participantSid = participant.sid
        el.style.position = 'absolute'
        el.style.left     = '-9999px'
        document.body.appendChild(el)
      }
    })

    try {
      // mic track w/ auto gain, stereo @48 kHz
      localAudioTrack = await createLocalAudioTrack({
        autoGainControl: true,
        channelCount: 2,
        sampleRate: 48000,
      })
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
   * Update volumes & positions:
   * • ≤10 yd ⇒ vol=1
   * • 10–50 yd ⇒ vol linearly fades 1→0
   * • >50 yd   ⇒ vol=0
   */
  function updateAudioVolumes(withinRange, self = {}) {
    if (!joinedRoom || !livekitRoom) return

    livekitRoom.participants.forEach(participant => {
      participant.audioTracks.forEach(pub => {
        const track = pub.track
        if (track?.kind === 'audio') {
          // find matching proximity entry
          const p = withinRange.find(x => String(x.guid) === participant.identity)
          let vol = 0
          if (p) {
            if (p.distance <= 10) {
              vol = 1
            } else if (p.distance < 50) {
              vol = 1 - (p.distance - 10) / 40
            }
            vol = Math.max(0, Math.min(1, vol))
            track.setSpatialPosition(
              p.x - self.x,
              p.y - self.y,
              (p.z || 0) - (self.z || 0)
            )
          }
          track.setVolume(vol)
        }
      })
    })
  }

  /** Process each proximity payload */
  async function handleProximityUpdate(data) {
    if (!guid || typeof data !== 'object') return

    const allPlayers = Object.values(data).flat()
    const self = allPlayers.find(p => String(p.guid) === String(guid))
    if (!self) {
      log('Self GUID not found in payload')
      return
    }

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

    // always ensure room is joined and volumes updated
    if (nearby.length > 0) {
      await joinLivekitRoom(self.map)
    }
    if (joinedRoom) {
      updateAudioVolumes(nearby, self)
    }
  }

  /** Mute/unmute your mic via toggleMic(true/false) */
  function toggleMic(muted) {
    if (!localAudioTrack) return
    if (muted) localAudioTrack.mute()
    else       localAudioTrack.unmute()
  }

  /** Clean up WS + LiveKit */
  function dispose() {
    clearTimeout(reconnectTimer)
    proximitySocket?.close()
    livekitRoom?.disconnect()
    proximitySocket = null
    livekitRoom   = null
    joinedRoom    = false
  }

  return {
    setGuid,
    connectToProximitySocket,
    dispose,
    nearbyPlayers,
    toggleMic,
  }
}