<template>
  <div>
    <NuxtRouteAnnouncer />
    <nav>
      <NuxtLink to="/">Home</NuxtLink> · <NuxtLink to="/about">About</NuxtLink> ·
      <NuxtLink to="/posts/1">Post 1</NuxtLink> · <NuxtLink to="/posts/2">Post 2</NuxtLink>
    </nav>
    <NuxtPage />
  </div>
</template>

<style>
body {
  font-family: 'Inter Variable', sans-serif;
}
</style>
