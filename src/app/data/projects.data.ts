import { Project } from './portfolio.models';

/** All project content, ported verbatim from the legacy site. */
export const PROJECTS: Project[] = [
  {
    slug: 'agritech',
    title: 'AgriTech — Farmers App',
    tagline:
      'A real-time bidding app with a transparent, open network where anyone can sell their crops at a fair rate.',
    image: 'assets/img/tech/agritech.png',
    kind: 'Full Stack',
    tags: ['Angular', 'Node.js', 'Express', 'MongoDB', 'Docker', 'NLP', 'ML'],
    links: [
      { label: 'Live Demo', url: 'https://farmersapp-microbits.firebaseapp.com/', icon: 'lucideExternalLink' },
      { label: 'GitHub', url: 'https://github.com/mohakchugh/farmersapp', icon: 'lucideGithub' },
      {
        label: 'Presentation',
        url: 'https://docs.google.com/presentation/d/1xDPth2sxfXL4W2G8_0gDD7KL_TM6q0hYhag-hjXBiQY/edit',
        icon: 'lucideFileText',
      },
    ],
    sections: [
      {
        body: [
          'AgriTech aspires to make the process of connecting suppliers and consumers seamless, through an "open and transparent channel" using the ideology of "an everything store for people expecting more" where producers get all the information they need for high profitability and consumers get the best quality produce directly from the farm. Penny-pinching, while you enjoy your fresh veggies!',
        ],
      },
      {
        heading: 'Our role in the Indian market',
        body: [
          'We ensure natural supply-demand by digitizing the process, thereby reducing inflation and reducing the scope of profiteering. Normalised rates are automatically enforced because of the vast variety of supplies from producers. We reduce income disparity between large- and small-scale farmers by providing them the same level playing ground. It is an initiative taken to organise an unorganised sector.',
        ],
      },
      {
        heading: 'Architecture',
        body: [
          'AgriTech uses a 3-tier architecture. The frontend is powered by Angular, providing strong static typing at the client side and robust state management for a seamless user experience. The middle tier is implemented as Dockerized microservices using Express on Node.js, enabling high performance and coordinating with our Python modules for NLP and image processing. The physical tier integrates SQL and NoSQL (MongoDB) databases featuring strong relational mappings, flexibility and a high level of robustness.',
        ],
      },
      {
        heading: 'Quirks and features',
        body: [
          'Producers and consumers register and authenticate into our app or via WhatsApp. Guided by our voice assistant at each step, the producer can update information about their produce, or use "OK Google", WhatsApp and Facebook Messenger for the same on our platform. As soon as produce is posted, it is put up as a bid for buyers on our bidding feed. Real-time bidding takes place and the highest bidder claims the produce. Buyers can use the "Buy Now" feature to bypass bidding and claim the product directly at a fixed price stated by the producer. Once a bid is updated, expired or claimed, the producer and highest bidder are always notified via SMS, WhatsApp and push notifications. When the buyer claims the bid, they pay 15% of the total amount as a refundable token; on completion of delivery, the buyer pays the remaining 85%.',
        ],
      },
    ],
  },
  {
    slug: 'citizens',
    title: 'Citizens App',
    tagline:
      'Reach out to government officials through an open and transparent channel — by tweeting at them, messaging on WhatsApp, or via our web portal.',
    image: 'assets/img/tech/citizens.png',
    kind: 'Full Stack',
    tags: ['Angular', 'Firebase', 'Node.js', 'Social Integration'],
    links: [
      { label: 'Live Demo', url: 'https://citizensapp.firebaseapp.com/', icon: 'lucideExternalLink' },
      { label: 'GitHub', url: 'https://github.com/MohakChugh/Citizensapp', icon: 'lucideGithub' },
      {
        label: 'Presentation',
        url: 'https://docs.google.com/presentation/d/1vr-UgDl6nfJExo42RxD7eqOwlWR6SBeefC36Fz5c7vc/edit',
        icon: 'lucideFileText',
      },
    ],
    sections: [
      {
        heading: 'A smart app for citizen–government collaboration',
        body: [
          'The application enables citizens to report local problems such as potholes, illegal trash dumping, faulty street lights, broken sidewalk tiles, and illegal advertising boards. A digitized platform to report such issues avoids redundant complaints, gives remote areas easier access to government, and ensures streamlined action. To file a complaint, citizens can first check for a similar existing complaint and add their digital signature to amplify the impact of a particular issue.',
        ],
      },
      {
        heading: 'Context',
        body: [
          'A city becomes smarter only when citizens and government work together. In a smart city, every citizen should be able to report local problems effectively, anonymously (if required), via a transparent process that reaches every remote area of the city.',
        ],
      },
    ],
  },
  {
    slug: 'content-collaborator',
    title: 'Content Collaborator',
    tagline:
      'A real-time content editor that lets a group of users collaborate on documents or webpage content, see changes live, and publish in no time.',
    image: 'assets/img/tech/text-editor.jpg',
    video: 'assets/img/tech/text-editor.mp4',
    kind: 'Full Stack',
    tags: ['Angular', 'Node.js', 'MongoDB', 'WebSockets', 'Docker'],
    links: [
      { label: 'GitHub', url: 'https://github.com/MohakChugh/Content-Collaborator', icon: 'lucideGithub' },
    ],
    sections: [
      {
        body: [
          'This is a real-time content editor which allows a group of users to collaborate on documents or webpage contents, see changes in real time, make changes as they go, and upload the content in no time.',
        ],
      },
      {
        heading: 'How real-time collaboration works',
        body: [
          'After the initial login/registration you see the editor. Everyone connected to the server who is logged in can see the editor, make changes to the document, see changes in real time, and then push the HTML created from the editor into the database. When everyone logged in is on the editor page, they are instantly connected to the server and can make changes to the document as they proceed.',
        ],
      },
    ],
  },
  {
    slug: 'property-management',
    title: 'Property Management',
    tagline: 'A highly secure and beautiful property management system, with a strong emphasis on security.',
    image: 'assets/img/tech/pm.png',
    kind: 'Full Stack',
    tags: ['Angular 8', 'Node.js', 'PostgreSQL', 'Hasura GraphQL', 'Heroku', 'Firebase'],
    links: [
      { label: 'Live Demo', url: 'https://mnrproject.firebaseapp.com/', icon: 'lucideExternalLink' },
    ],
    sections: [
      {
        body: ['A highly secure and beautiful property management system, with a high emphasis on security.'],
      },
      {
        heading: 'Stack',
        bullets: [
          'Backend created on Node.js and deployed on Heroku',
          'Database: PostgreSQL with Hasura GraphQL Engine, deployed to Heroku',
          'Frontend built on Angular 8 and deployed on Firebase',
        ],
      },
    ],
  },
  {
    slug: 'drone-dash',
    title: 'Drone Dash',
    tagline:
      'A one-stop dashboard for surveillance using drones — SMS & email integration, report generation, scheduling, messaging, role-based access and more.',
    image: 'assets/img/tech/dronedash.png',
    kind: 'Dashboard',
    tags: ['Angular', 'Node.js', 'PostgreSQL', 'Hasura GraphQL', 'AWS S3'],
    links: [
      { label: 'Live Demo', url: 'http://dashboard.omnipresenttech.com/', icon: 'lucideExternalLink' },
      { label: 'GitHub', url: 'https://github.com/MohakChugh/DroneDash', icon: 'lucideGithub' },
    ],
    sections: [
      {
        body: [
          'Drone Dash is a dashboard for surveillance using drones. It provides role-based access, reports, instructions to the pilot, flight status, communication between clients and the admin, livestreaming, schedule uploads and much more.',
          'Drone Dash is built using Angular, Node.js, PostgreSQL and Hasura GraphQL Engine, with file uploads on an AWS S3 bucket.',
        ],
      },
      {
        heading: 'Features',
        bullets: [
          'SMS and email integration for notifications',
          'Report validation by admin',
          'Role-based access (admin, semi-admin, client and pilot)',
          'Messaging service',
          'Flight stats and logs, and much more',
        ],
      },
    ],
  },
  {
    slug: 'classifier-selector',
    title: 'Classifier Selector',
    tagline:
      'A machine-learning dashboard for predicting the class of the Iris dataset, with support for multiple classifiers.',
    image: 'assets/img/tech/Dashboard_Demo.jpg',
    video: 'assets/img/tech/Dashboard_Demo.mp4',
    kind: 'Dashboard',
    tags: ['Python', 'Machine Learning', 'Dashboard', 'scikit-learn'],
    links: [
      { label: 'GitHub', url: 'https://github.com/MohakChugh/DataDashboards', icon: 'lucideGithub' },
    ],
    sections: [
      {
        heading: 'Machine Learning Classifier Dashboard for the IRIS dataset',
        body: ['A machine-learning dashboard for prediction of the class of the Iris dataset.'],
        bullets: [
          'K Nearest Neighbours',
          'Logistic Regression',
          'Decision Tree Classifier',
          'Random Forest',
          'Support Vector Machine',
        ],
      },
      {
        heading: 'Features',
        bullets: [
          'Prediction',
          'Comparison between multiple classifiers',
          'Trends and dataset view',
          'See the accuracy directly while selecting the classifier',
        ],
      },
    ],
  },
];

export const PROJECT_MAP = new Map(PROJECTS.map((p) => [p.slug, p]));
