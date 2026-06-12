const fs = require("node:fs");
const http = require("node:http");

if (!fs.existsSync(".bootproof/prisma-ready")) {
  console.error("Prisma P3009 Migration pending");
  process.exit(1);
}

const port = Number(process.env.PORT);
http.createServer((_request, response) => {
  response.statusCode = 200;
  response.end("prisma repair fixture ok");
}).listen(port, "127.0.0.1");
