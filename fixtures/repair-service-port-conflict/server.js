const http = require("node:http");

const port = Number(process.env.PORT);
http.createServer((_request, response) => {
  response.statusCode = 200;
  response.end("repair fixture ok");
}).listen(port, "127.0.0.1");
