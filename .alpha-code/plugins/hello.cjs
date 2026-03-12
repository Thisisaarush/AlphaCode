module.exports = {
  id: "hello-plugin",
  label: "Hello Plugin",
  version: "0.1.0",
  tools: [
    {
      id: "hello_world",
      description: "Return a friendly greeting.",
      handler: async (args) => {
        const name = typeof args?.name === "string" ? args.name : "world";
        return `Hello, ${name}!`;
      }
    }
  ]
};
