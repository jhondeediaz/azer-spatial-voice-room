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

    <!-- Main UI -->
    <div v-else class="main-ui">
      <label>
        <input type="checkbox" v-model="muted" />
        Mute (mic only)
      </label>
      <label>
        <input type="checkbox" v-model="deafened" />
        Deafen (mic + speakers)
      </label>
      <button @click="resetGuid">Change ID</button>

      <!-- Audio players rendered by Vue so volume bindings work -->
      <div class="audio-container">
        <audio
          v-for="p in nearbyPlayers"
          :key="p.guid"
          :data-guid="p.guid"
          autoplay
          playsinline
          :volume="computeVolume(p.distance)"
          :muted="deafened"
        ></audio>
      </div>

      <!-- Debug list -->
      <div class="debug" v-show="debug">
        <h3>Nearby Players</h3>
        <ul>
          <li v-if="nearbyPlayers.length === 0">No players nearby</li>
          <li v-for="p in nearbyPlayers" :key="p.guid">
            GUID {{ p.guid }} — {{ p.distance.toFixed(1) }} yd
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import usePlayerPositionEmitter from '@composables/usePlayerPositionEmitter'

const {
  setGuid,
  connectToProximitySocket,
  dispose,
  nearbyPlayers,
  toggleMic
} = usePlayerPositionEmitter()

// UI state
const guidInput = ref('')
const guidSet   = ref(false)
const muted     = ref(false)
const deafened  = ref(false)
const debug = ref(false)

// Mic mute/unmute binding
watch(muted, val => {
  if (!val && deafened.value) {
    // If unmuting while deafened, also undeafen
    deafened.value = false
  }
  toggleMic(val)
})
// Deafening forces mute
watch(deafened, val => {
  if (val) muted.value = true
  toggleMic(muted.value)
})

function computeVolume(d) {
  if (d <= 10) return 1
  if (d >= 150) return 0
  return 1 - (d - 10) / 140
}
onMounted(() => {
  const saved = localStorage.getItem('guid')
  if (saved) {
    setGuid(Number(saved))
    guidInput.value = saved
    guidSet.value    = true
    connectToProximitySocket()
  }
})

onUnmounted(() => dispose())

function setGuidHandler() {
  if (!guidInput.value) return
  localStorage.setItem('guid', guidInput.value)
  setGuid(Number(guidInput.value))
  guidSet.value = true
  connectToProximitySocket()
}

function resetGuid() {
  localStorage.removeItem('guid')
  guidInput.value = ''
  guidSet.value    = false
}
</script>

<style>
.guid-prompt,
.main-ui {
  max-width: 320px;
  background: #23233a;
  border-radius: 8px;
  box-shadow: 0 2px 8px #0002;
  font-size: 0.95rem;
}

input[type='number'],
button {
  font-size: 0.9rem;
  background: #2e2e40;
  color: white;
  border: none;
  border-radius: 4px;
}

button {
  margin-top: 0.3rem;
}

button:hover { background: #44445c; }
label { display: block; margin: 0.3rem 0; font-size: 0.95em; }
.audio-container { margin: 0.5rem 0; }
.audio-container audio { width: 100%; margin-bottom: 0.3rem; }
.debug { margin-top: 0.5rem; font-size: 0.8rem; }
</style>