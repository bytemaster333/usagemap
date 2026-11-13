# SPDX-License-Identifier: Apache-2.0
FROM mcr.microsoft.com/dotnet/sdk:10.0.404 AS build
WORKDIR /src
COPY S06bApi.csproj ./
RUN --mount=type=cache,target=/root/.nuget/packages dotnet restore
COPY Program.cs ./
RUN --mount=type=cache,target=/root/.nuget/packages dotnet publish -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0.15
WORKDIR /app
COPY --from=build /out ./
EXPOSE 8080
ENTRYPOINT ["dotnet", "S06bApi.dll"]
