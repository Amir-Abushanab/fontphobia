import { defineConfig, type Plugin } from "vite";
import { octane } from "@octanejs/vite-plugin";

const probe: Plugin = {
  name: "probe",
  closeBundle() {
    console.log("[probe] closeBundle", this.environment?.name ?? "-");
  },
};

export default defineConfig({
  plugins: [octane(), probe],
  build: { target: "esnext" },
});
