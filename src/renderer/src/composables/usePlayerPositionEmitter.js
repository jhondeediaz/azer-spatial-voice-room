// src/renderer/src/composables/usePlayerPositionEmitter.js
import { ref } from 'vue'
import { Room, createLocalAudioTrack } from 'livekit-client'

const PROXIMITY_WS      = import.meta.env.VITE_PROXIMITY_WS
const LIVEKIT_URL       = import.meta.env.VITE_LIVEKIT_URL
const TOKEN_SERVICE_URL = import.meta.env.VITE_LIVEKIT_TOKEN_SERVICE_URL

export default function usePlayerPositionEmitter() {
  // reactive list of { guid, distance } you can v-for over
  const nearbyPlayers = ref([])

  let ws              = null
  let reconnectTimer  = null
  let guid            = null
  let livekitRoom     = null
  let currentMap      = null
  let localAudioTrack = null

  function log(...args) { console.log('[usePlayerPositionEmitter]', ...args) }

  /** called once from your UI */
  function setGuid(x) {
    guid = x
  }

  /** open or reopen the proximity WebSocket */
  function connectToProximitySocket() {
    if (!guid) {
      log('✋ cannot connect, GUID not set')
      return
    }
    if (
      ws &&
      (ws.readyState === WebSocket.CONNECTING ||
       ws.readyState === WebSocket.OPEN)
    ) {
      return log('🔄 WS already open')
    }
    ws = new WebSocket(PROXIMITY_WS)
    ws.onopen    = () => { log('✅ Proximity WS connected'); ws.send(JSON.stringify({ guid })) }
    ws.onerror   = e => log('⚠️ WS error', e)
    ws.onclose   = () => {
      log('❌ WS closed, retry in 2s')
      reconnectTimer = setTimeout(connectToProximitySocket, 2000)
    }
    ws.onmessage = e => {
      let data
      try { data = JSON.parse(e.data) }
      catch { return log('⚠️ Bad JSON:', e.data) }
      handleProximityUpdate(data)
    }
  }

  /** fetch a fresh LiveKit token, connect & publish mic */
  async function joinLivekitRoom(mapId) {
    // skip if already in this map
    if (livekitRoom && currentMap === mapId) return
    // if switching maps, tear down
    if (livekitRoom) {
      await livekitRoom.disconnect().catch(e => log('disconnect error', e))
      livekitRoom = null
    }

    // 1) grab token
    let tokenStr
    try {
      const res = await fetch(`${TOKEN_SERVICE_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid, room: String(mapId) }),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const json = await res.json()
      // payload.token or payload.token.token
      tokenStr = typeof json.token === 'string'
        ? json.token
        : json.token?.token
      if (!tokenStr) throw new Error('invalid token payload')
      log('🎟 using token', tokenStr.slice(0,8)+'…')
    } catch (err) {
      return log('⚠️ token fetch failed', err)
    }

    // 2) connect & publish
    livekitRoom = new Room()
    try {
      localAudioTrack = await createLocalAudioTrack({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      })
      await livekitRoom.connect(LIVEKIT_URL, tokenStr, {
        name: String(guid),
        autoSubscribe: true,
        room: String(mapId),
      })
      await livekitRoom.localParticipant.publishTrack(localAudioTrack)
      currentMap = mapId
      log('🎧 LiveKit connected to map', mapId)
    } catch (err) {
      log('⚠️ LiveKit connect failed', err)
    }
  }

  /**
   * called on every WS update
   *   - recalcs nearbyPlayers (≤50 yd)
   *   - ensures we’re in the right LiveKit “map” room
   */
  async function handleProximityUpdate(data) {
    if (!guid || typeof data !== 'object') return

    const all = Object.values(data).flat()
    const self = all.find(p => String(p.guid) === String(guid))
    if (!self) return log('⚠️ self not found in payload')

    // compute distances for same-map peers
    const peers = all
      .filter(p => p.guid !== guid && String(p.map) === String(self.map))
      .map(p => ({
        guid: p.guid,
        distance: Math.hypot(p.x - self.x, p.y - self.y, (p.z||0) - (self.z||0))
      }))
      .filter(p => p.distance <= 50)

    nearbyPlayers.value = peers
    log('🔍 nearbyPlayers', peers)

    // join/switch the LiveKit room & let the template handle volume
    await joinLivekitRoom(self.map)
  }

  /** mute/unmute your mic */
  function toggleMic(muted) {
    if (!localAudioTrack) return
    muted ? localAudioTrack.mute() : localAudioTrack.unmute()
  }

  /** cleanup WS + LiveKit */
  function dispose() {
    clearTimeout(reconnectTimer)
    ws?.close()
    livekitRoom?.disconnect()
    livekitRoom = null
  }

  return {
    nearbyPlayers,
    setGuid,
    connectToProximitySocket,
    toggleMic,
    dispose,
  }
}