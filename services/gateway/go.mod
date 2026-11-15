module github.com/bytemaster333/usagemap/services/gateway

go 1.27

require (
	github.com/oschwald/maxminddb-golang/v2 v2.9.0
	github.com/bytemaster333/usagemap/packages/pathnorm v0.0.0
	golang.org/x/sys v0.49.0
)

replace github.com/bytemaster333/usagemap/packages/pathnorm => ../../packages/pathnorm
