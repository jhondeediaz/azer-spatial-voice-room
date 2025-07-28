<template>
  <div id="app">
    <ProximityDashboard />
  </div>
</template>

<script setup>
import ProximityDashboard from './views/ProximityDashboard.vue'
</script>

<style>
body {
  background: #1e1e2f;
  color: #eee;
  margin: 0;
  font-family: sans-serif;
}
#app {
  padding: 1rem;
  width: 250px;
}
</style>
