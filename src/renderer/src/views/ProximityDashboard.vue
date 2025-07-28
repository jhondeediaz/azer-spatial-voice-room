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
      <button @click="resetGuid">Change GUID</button>

      <h3>Nearby Players (≤150 yd)</h3>
      <ul>
        <li v-if="nearbyPlayers.length === 0">No one nearby</li>
        <li v-for="p in nearbyPlayers" :key="p.guid">
          GUID {{ p.guid }} — {{ p.distance.toFixed(1) }} yd
        </li>
      </ul>

      <!-- Hidden audio tags, bound to Vue so volume updates automatically -->
      <div class="audio-container">
        <audio
          v-for="p in nearbyPlayers"
          :key="p.guid"
          ref="audios"
          autoplay
          playsinline
          :muted="deafened"
          :volume="computeVolume(p.distance)"
          :data-guid="p.guid"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue';
import usePlayerPositionEmitter from '@composables/usePlayerPositionEmitter';

const {
  setGuid,
  connectToProximitySocket,
  dispose,
  nearbyPlayers,
  toggleMic
} = usePlayerPositionEmitter();

const guidInput = ref('');
const guidSet   = ref(false);
const muted     = ref(false);
const deafened  = ref(false);

// mute/unmute your mic
watch(muted, m => toggleMic(m));

// if you “deafen” we also force‐mute
watch(deafened, d => {
  muted.value = d;
  toggleMic(d);
});

// compute volume falloff:
//   ≤30 yd  → 1
//   30–150 yd → linear fade to 0
//   ≥150 yd → 0
function computeVolume(d) {
  if (d <= 30) return 1;
  if (d >= 150) return 0;
  return 1 - (d - 30) / 120;
}

onMounted(() => {
  const saved = localStorage.getItem('guid');
  if (saved) {
    setGuid(Number(saved));
    guidInput.value = saved;
    guidSet.value   = true;
    connectToProximitySocket();
  }
});

onUnmounted(() => dispose());

function setGuidHandler() {
  if (!guidInput.value) return;
  localStorage.setItem('guid', guidInput.value);
  setGuid(Number(guidInput.value));
  guidSet.value = true;
  connectToProximitySocket();
}

function resetGuid() {
  localStorage.removeItem('guid');
  guidInput.value = '';
  guidSet.value   = false;
}
</script>

<style>
.guid-prompt {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
input, button {
  padding: 0.5rem;
  font-size: 0.9rem;
  background: #2e2e40;
  color: white;
  border: none;
  border-radius: 4px;
}
button:hover { background: #44445c; }
label { display: block; margin-top: 0.5rem; }
.audio-container { display: none; /* keep them in DOM only */ }
.debug { margin-top: 1rem; font-size: 0.8rem; }
</style>