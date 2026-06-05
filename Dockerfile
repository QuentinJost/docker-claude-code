FROM node:slim

WORKDIR /app

RUN npm install -g @anthropic-ai/claude-code

RUN apt-get update && apt-get install -y \
    python3 \
    php \
    golang-go \
    git \
    ca-certificates curl gnupg lsb-release \
    ;

RUN curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
RUN echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian bullseye stable" > /etc/apt/sources.list.d/docker.list
RUN apt update && apt -y install docker-ce docker-ce-cli containerd.io

# Install rtk (Rust Token Killer) system-wide so www-data can use it
RUN curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh \
    && cp /root/.local/bin/rtk /usr/local/bin/rtk \
    && chmod 755 /usr/local/bin/rtk \
    && rtk --version

COPY .config /var/www/.config
COPY .claude /var/www/.claude
RUN mkdir -p /var/www/.cache/claude

RUN groupmod -o -g 1000 www-data && \
    usermod -o -u 1000 www-data
RUN chown -R www-data:www-data /var/www/.cache/claude /var/www/.claude /var/www/.config

RUN usermod -aG docker www-data
USER www-data

CMD ["sleep", "infinity"]