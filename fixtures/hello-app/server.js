const http = require("http");
const port = process.env.PORT || 3000;
http.createServer((req, res) => res.end("hello from fixture")).listen(port, () => console.log("listening on " + port));
