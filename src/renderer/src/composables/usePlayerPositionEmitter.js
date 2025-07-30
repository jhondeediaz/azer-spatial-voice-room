import { ref, nextTick } from 'vue'
import { Room, createLocalAudioTrack } from 'livekit-client'

const PROXIMITY_WS      = import.meta.env.VITE_PROXIMITY_WS
const LIVEKIT_URL       = import.meta.env.VITE_LIVEKIT_URL
const TOKEN_SERVICE_URL = import.meta.env.VITE_LIVEKIT_TOKEN_SERVICE_URL

// Shared AudioContext for positional audio
let sharedAudioContext = null

export default function usePlayerPositionEmitter() {
  const nearbyPlayers  = ref([])
  let ws               = null
  let reconnectTimer   = null
  let guid             = null
  let livekitRoom      = null
  let currentMap       = null
  let localAudioTrack  = null
  const audioContexts  = new Map()  // guid -> { stereoPanner, source, el }

  function log(...args) {
    console.log('[usePlayerPositionEmitter]', ...args)
  }

  /** UI calls this to set your GUID */
  function setGuid(x) {
    guid = x
  }

  /** Open or re-open your proximity websocket */
  function connectToProximitySocket() {
    if (!guid) {
      log('🚫 GUID not set')
      return
    }
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return
    }

    ws = new WebSocket(PROXIMITY_WS)
    ws.onopen = () => {
      log('✅ Proximity WS connected')
      ws.send(JSON.stringify({ guid }))
    }
    ws.onerror = e => log('⚠️ WS error', e)
    ws.onclose = () => {
      log('🔁 WS closed, reconnecting in 2s')
      reconnectTimer = setTimeout(connectToProximitySocket, 2000)
    }
    ws.onmessage = e => {
      let data
      try { data = JSON.parse(e.data) }
      catch { return log('⚠️ Bad JSON', e.data) }
      handleProximityUpdate(data)
    }
  }

  /** Fetch a token, connect to LiveKit, and publish your mic */
  async function joinLivekitRoom(mapId) {
    if (livekitRoom && currentMap === mapId) return

    if (livekitRoom) {
      await livekitRoom.disconnect().catch(e => log('disconnect err', e))
      livekitRoom = null
    }

    // fetch token
    let tokenStr
    try {
      const res = await fetch(`${TOKEN_SERVICE_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid, room: String(mapId) }),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const json = await res.json()
      tokenStr = typeof json.token === 'string'
        ? json.token
        : json.token?.token
      if (!tokenStr) throw new Error('invalid token payload')
      log('🎟 using token…')
    } catch (err) {
      return log('⚠️ token fetch failed', err)
    }

    // connect & publish
    livekitRoom = new Room()
    livekitRoom.on('trackSubscribed', (track, _, participant) => {
      const el = document.querySelector(`audio[data-guid="${participant.identity}"]`)
      if (el) track.attach(el)
      else console.warn('no <audio> for', participant.identity)
    })

    try {
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
      currentMap = mapId
      log('🎧 LiveKit map', mapId)
    } catch (err) {
      log('⚠️ LiveKit connect failed', err)
    }
  }

  /** Handle incoming proximity data, update volumes & panning */
  async function handleProximityUpdate(data) {
    if (!guid || typeof data !== 'object') return

    const all = Object.values(data).flat()
    const self = all.find(p => String(p.guid) === String(guid))
    if (!self) return log('⚠️ self not in payload')

    const peers = all
      .filter(p => p.guid !== guid && String(p.map) === String(self.map))
      .map(p => ({
        guid: p.guid,
        x: p.x, y: p.y, z: p.z || 0,
        distance: Math.hypot(p.x - self.x, p.y - self.y, (p.z||0)-(self.z||0)),
      }))
      .filter(p => p.distance <= 150)

    nearbyPlayers.value = peers
    log('🔍 nearby', peers)

    await joinLivekitRoom(self.map)
    await nextTick()

    if (!sharedAudioContext) {
      sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)()
    }

    peers.forEach(p => {
      const participant = livekitRoom.getParticipantByIdentity(String(p.guid))
      if (!participant) return

      participant.getTrackPublications().forEach(pub => {
        const track = pub.track
        if (!track || track.kind !== 'audio') return

        const el = document.querySelector(`audio[data-guid="${p.guid}"]`)
        if (!el) return

        track.attach(el)
        let entry = audioContexts.get(p.guid)

        // volume calculation
        const minD = 5, maxD = 150
        let volume = p.distance <= minD
          ? 1
          : p.distance >= maxD
            ? 0
            : 1 - (p.distance - minD) / (maxD - minD)
        el.volume = Math.max(0, Math.min(1, volume))

        // pan calculation
        const panRange = 5
        let pan = (p.x - self.x) / panRange
        pan = Math.max(-1, Math.min(1, pan))

        if (!entry) {
          const source = sharedAudioContext.createMediaElementSource(el)
          const stereoPanner = sharedAudioContext.createStereoPanner()
          stereoPanner.pan.setValueAtTime(pan, sharedAudioContext.currentTime)
          source.connect(stereoPanner).connect(sharedAudioContext.destination)
          audioContexts.set(p.guid, { stereoPanner, source, el })
        } else {
          entry.stereoPanner.pan.setValueAtTime(pan, sharedAudioContext.currentTime)
        }
      })
    })
  }

  /** Mute/unmute your mic */
  function toggleMic(mute) {
    if (!localAudioTrack) return
    mute ? localAudioTrack.mute() : localAudioTrack.unmute()
  }

  /** 📢 Runtime mic‐change: unpublish old track, publish new one */
  async function changeMic(deviceId) {
    if (!livekitRoom) return
    if (localAudioTrack) {
      await livekitRoom.localParticipant.unpublishTrack(localAudioTrack)
      localAudioTrack.stop()
      localAudioTrack = null
    }
    localAudioTrack = await createLocalAudioTrack({
      deviceId: { exact: deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    })
    await livekitRoom.localParticipant.publishTrack(localAudioTrack)
  }

  /** Clean-up */
  function dispose() {
    clearTimeout(reconnectTimer)
    ws?.close()
    livekitRoom?.disconnect()
    livekitRoom = null

    audioContexts.forEach(({ stereoPanner, source }) => {
      try { source.disconnect() } catch {}
      try { stereoPanner.disconnect() } catch {}
    })
    audioContexts.clear()

    if (sharedAudioContext) {
      sharedAudioContext.close()
      sharedAudioContext = null
    }
  }

  return {
    nearbyPlayers,
    setGuid,
    connectToProximitySocket,
    toggleMic,
    changeMic,
    dispose,
  }
}