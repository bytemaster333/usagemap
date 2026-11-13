# SPDX-License-Identifier: Apache-2.0
FROM maven:3.9.16-eclipse-temurin-25 AS build
WORKDIR /src
COPY pom.xml ./
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -q -B package -DskipTests

FROM eclipse-temurin:25.0.5_8-jre
WORKDIR /app
COPY --from=build /src/target/app.jar /src/target/opentelemetry-javaagent.jar ./
COPY otel/ ./otel/
EXPOSE 8080
ENTRYPOINT ["java", "-javaagent:/app/opentelemetry-javaagent.jar", "-jar", "/app/app.jar"]
