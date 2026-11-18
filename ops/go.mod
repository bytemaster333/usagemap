module github.com/bytemaster333/usagemap/ops

go 1.27

require github.com/bytemaster333/usagemap/services/gateway v0.0.0

replace (
	github.com/bytemaster333/usagemap/packages/pathnorm => ../packages/pathnorm
	github.com/bytemaster333/usagemap/services/gateway => ../services/gateway
)
