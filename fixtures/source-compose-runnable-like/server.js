const http = require("node:http");

const port = Number(process.env.PORT || 31999);
http.createServer((_request, response) => {
  response.statusCode = 200;
  response.end("compose fixture ok");
}).listen(port, "127.0.0.1");
