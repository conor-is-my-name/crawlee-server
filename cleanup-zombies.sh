#!/bin/bash

# Script to clean up zombie processes in Docker containers
echo "Checking for zombie processes in scraper containers..."

for i in {1..12}; do
    CONTAINER="crawlee-server-scraper${i}-1"

    # Check if container exists and is running
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
        # Count zombie processes
        ZOMBIE_COUNT=$(docker exec ${CONTAINER} ps aux | grep -c "<defunct>" 2>/dev/null || echo 0)

        if [ $ZOMBIE_COUNT -gt 100 ]; then
            echo "Container ${CONTAINER} has ${ZOMBIE_COUNT} zombie processes - restarting..."
            docker restart ${CONTAINER}
        elif [ $ZOMBIE_COUNT -gt 0 ]; then
            echo "Container ${CONTAINER} has ${ZOMBIE_COUNT} zombie processes"
        fi
    fi
done

echo "Zombie process check complete"