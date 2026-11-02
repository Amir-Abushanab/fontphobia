import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const probe = {
  name: "probe",
  closeBundle(this: any) {
    console.log("[probe] closeBundle", this.environment?.name ?? "-");
  },
};

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), probe],
  resolve: {
    tsconfigPaths: true,
  },
});
