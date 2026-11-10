const express = require("express");
const app = express();
require("./discount-badge-sync")(app);
app.get("/", (req, res) => res.send("Discount badge sync is running."));
app.listen(process.env.PORT || 3000, () => console.log("listening"));
