<script setup lang="ts">
const route = useRoute();
</script>

<template>
  <h1>Post {{ route.params.id }}</h1>
</template>
