const http = require("node:http");

const port = Number(process.env.PORT || 3000);
http.createServer((_request, response) => {
  response.statusCode = 200;
  response.end("make fixture ok");
}).listen(port, "127.0.0.1", () => {
  console.log(`server listening on http://localhost:${port}/`);
});
