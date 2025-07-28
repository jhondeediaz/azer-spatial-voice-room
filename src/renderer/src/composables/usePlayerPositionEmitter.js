// src/renderer/src/composables/usePlayerPositionEmitter.js
import { ref } from 'vue'
import { Room, createLocalAudioTrack } from 'livekit-client'

const PROXIMITY_WS      = import.meta.env.VITE_PROXIMITY_WS
const LIVEKIT_URL       = import.meta.env.VITE_LIVEKIT_URL
const TOKEN_SERVICE_URL = import.meta.env.VITE_LIVEKIT_TOKEN_SERVICE_URL

export default function usePlayerPositionEmitter() {
  const nearbyPlayers = ref([])

  let proximitySocket = null
  let reconnectTimer  = null
  let guid            = null
  let livekitRoom     = null
  let currentRoomId   = null
  let joinedRoom      = false
  let localAudioTrack = null

  const DEBUG = true
  function log(...args) { if (DEBUG) console.log('[usePlayerPositionEmitter]', ...args) }

  /** call once from your UI */
  function setGuid(playerGuid) {
    guid = playerGuid
  }

  /** open/reopen WebSocket */
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
      log('Proximity WS: Closed, reconnecting…')
      reconnectTimer = setTimeout(connectToProximitySocket, 2000)
    }
    proximitySocket.onmessage = e => {
      let data
      try { data = JSON.parse(e.data) }
      catch { return log('Bad proximity JSON:', e.data) }
      handleProximityUpdate(data)
    }
  }

  /** fetch token, connect & publish, per map‐room */
  async function joinLivekitRoom(mapId) {
    if (joinedRoom && currentRoomId === mapId) return

    if (joinedRoom && currentRoomId !== mapId) {
      try { await livekitRoom.disconnect() }
      catch (e) { log('Disconnect error:', e) }
      joinedRoom = false
      currentRoomId = null
    }

    // get fresh JWT
    let tokenStr
    try {
      const res = await fetch(`${TOKEN_SERVICE_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid, room: String(mapId) }),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const payload = await res.json()
      if (typeof payload.token === 'string') {
        tokenStr = payload.token
      } else if (payload.token && typeof payload.token.token === 'string') {
        tokenStr = payload.token.token
      } else {
        throw new Error('Invalid token format')
      }
      log('Using token:', tokenStr)
    } catch (err) {
      return log('Token fetch error:', err)
    }

    // new Room & track handler
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
      // turn off echo/noise for cleaner volume control
      localAudioTrack = await createLocalAudioTrack({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
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
      log('LiveKit connect failed:', err)
    }
  }

  /**
   * pure volume fade:
   *   ≤10 yd  → vol = 1
   *  10–50 yd → linearly fade 1 → 0
   *   ≥50 yd  → vol = 0
   */
  function updateAudioVolumes(withinRange, self) {
    if (!joinedRoom || !livekitRoom) return;

    // get array of participants
    const participants = typeof livekitRoom.getParticipants === 'function'
      ? livekitRoom.getParticipants()
      : [];

    participants.forEach(participant => {
      // each publication for this participant
      participant.getTrackPublications().forEach(pub => {
        const track = pub.track;
        if (!track || track.kind !== 'audio') return;

        // find matching proximity entry by GUID == identity
        const p = withinRange.find(x => String(x.guid) === participant.identity);
        let vol = 0;
        if (p) {
          if (p.distance <= 10) {
            vol = 1;
          } else if (p.distance < 50) {
            vol = 1 - (p.distance - 10) / 40;
          }
          vol = Math.max(0, Math.min(1, vol));
        }

        // apply volume
        track.setVolume(vol);
      });
    });
  }

  /** handle each WS update */
  async function handleProximityUpdate(data) {
    if (!guid || typeof data !== 'object') return

    // flatten and find self
    const allPlayers = Object.values(data).flat()
    const self       = allPlayers.find(p => String(p.guid) === String(guid))
    if (!self) {
      return log('Self GUID not in payload')
    }

    // compute others on same map
    const nearby = allPlayers
      .filter(p => String(p.guid) !== String(guid) && String(p.map) === String(self.map))
      .map(p => {
        const dx = p.x - self.x
        const dy = p.y - self.y
        const dz = (p.z||0) - (self.z||0)
        return { ...p, distance: Math.hypot(dx,dy,dz) }
      })
      .filter(p => p.distance <= 50)

    nearbyPlayers.value = nearby
    log('Nearby players:', nearby)

    // ensure room & apply volumes
    await joinLivekitRoom(self.map)
    if (joinedRoom) {
      updateAudioVolumes(nearby, self)
    }
  }

  /** mic mute/unmute for your UI */
  function toggleMic(mute) {
    if (!localAudioTrack) return
    mute ? localAudioTrack.mute() : localAudioTrack.unmute()
  }

  /** tear down on unmount */
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
  }
}