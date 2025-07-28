<template>
  <div>
    <!-- GUID prompt -->
    <div v-if="!guidSet" class="guid-prompt">
      <input
        v-model="guidInput"
        type="number"
        placeholder="Enter your GUID"
      />
      <button @click="setGuidHandler">OK</button>
    </div>

    <!-- main UI -->
    <div v-else class="main-ui">
      <label>
        <input type="checkbox" v-model="muted" />
        Mute (mic only)
      </label>

      <button @click="resetGuid">Change GUID</button>

      <div class="debug">
        <h3>Nearby Players</h3>
        <ul>
          <li v-if="nearbyPlayers.length === 0">
            No players within 50 yd
          </li>
          <li v-for="p in nearbyPlayers" :key="p.guid">
            GUID {{ p.guid }} — {{ p.distance.toFixed(1) }} yd
          </li>
        </ul>
      </div>

      <!-- one <audio> per player, Vue-rendered -->
      <div style="display:none">
        <audio
          v-for="p in nearbyPlayers"
          :key="p.guid"
          :data-guid="p.guid"
          ref="el => audioEls.set(p.guid, el)"
          autoplay
          playsinline
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import usePlayerPositionEmitter from '@composables/usePlayerPositionEmitter'

const {
  nearbyPlayers,
  setGuid,
  connectToProximitySocket,
  toggleMic,
  dispose
} = usePlayerPositionEmitter()

// UI state
const guidInput = ref('')
const guidSet   = ref(false)
const muted     = ref(false)

// store DOM refs: guid → HTMLAudioElement
const audioEls = ref(new Map())

// 1) wire mute checkbox
watch(muted, m => toggleMic(m))

// 2) whenever our list changes, update volumes
watch(nearbyPlayers, async list => {
  await nextTick()
  for (const p of list) {
    const el = audioEls.value.get(p.guid)
    if (!el) continue
    // ≤10 yd → 1 ; 10–50 yd → linearly fade → 0
    let v = p.distance <= 10
      ? 1
      : p.distance < 50
      ? 1 - (p.distance - 10) / 40
      : 0
    v = Math.max(0, Math.min(1, v))
    el.volume = v
  }
})

// startup / teardown
onMounted(() => {
  const saved = localStorage.getItem('guid')
  if (saved) {
    guidInput.value = saved
    guidSet.value   = true
    setGuid(Number(saved))
    connectToProximitySocket()
  }
})

onUnmounted(() => {
  dispose()
})

// handlers
function setGuidHandler() {
  if (!guidInput.value) return
  localStorage.setItem('guid', guidInput.value)
  guidSet.value = true
  setGuid(Number(guidInput.value))
  connectToProximitySocket()
}

function resetGuid() {
  localStorage.removeItem('guid')
  guidInput.value = ''
  guidSet.value   = false
}
</script>

<style>
.guid-prompt {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
input[type='number'], button {
  padding: 0.5rem;
  font-size: 0.9rem;
  background: #2e2e40;
  color: white;
  border: none;
  border-radius: 4px;
}
button:hover { background: #44445c; }
label { display: block; margin-top: 0.5rem; }
.debug { margin-top: 1rem; font-size: 0.8rem; }
</style>