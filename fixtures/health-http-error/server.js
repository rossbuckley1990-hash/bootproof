const http = require("http");

const port = Number(process.env.PORT || 3000);
http.createServer((_request, response) => {
  response.statusCode = 500;
  response.end("fixture failure");
}).listen(port);
