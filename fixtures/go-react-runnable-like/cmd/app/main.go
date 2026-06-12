package main

func main() {
	// Fixture evidence only: the test runtime shim executes server.js.
	port := Int("port", 8081)
	data := String("data", ".")
	_, _ = port, data
}

func Int(_ string, value int) int       { return value }
func String(_ string, value string) string { return value }
