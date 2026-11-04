<script setup lang="ts">
const route = useRoute()
</script>

<template>
  <main>
    <h1>Post {{ route.params.id }}</h1>
    <p>A short post. <strong>Bold words</strong> and plain ones.</p>
  </main>
</template>
