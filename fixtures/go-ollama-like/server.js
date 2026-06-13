const http = require("node:http");

http.createServer((request, response) => {
  response.statusCode = 200;
  if (request.url === "/api/tags") {
    response.setHeader("content-type", "application/json");
    response.end('{"models":[]}');
    return;
  }
  response.end("Ollama is running");
}).listen(11434, "127.0.0.1", () => {
  console.log("server listening on http://127.0.0.1:11434/");
});
