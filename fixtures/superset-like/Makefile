setup:
	superset db upgrade
	superset init

flask-app:
	flask run -p 8088 --reload --debugger

node-app:
	cd superset-frontend; npm run dev-server

worker:
	celery --app=superset.tasks.celery_app:app worker
