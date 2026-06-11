const http = require("node:http");

const portIndex = process.argv.findIndex((value) => value === "--port");
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : Number(process.env.PORT || 8081);
http.createServer((_request, response) => {
  response.statusCode = 200;
  response.end("go fixture ok");
}).listen(port, "127.0.0.1", () => {
  console.log(`server listening on http://localhost:${port}/`);
});
