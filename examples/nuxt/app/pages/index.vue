<!-- app/pages/index.vue — a custom event -->
<script setup lang="ts">
const { $scf } = useNuxtApp();
const signUp = () => $scf?.track("signup", { plan: "free" });
</script>

<template>
  <main>
    <h1>Home</h1>
    <button type="button" @click="signUp">Sign up</button>
  </main>
</template>
