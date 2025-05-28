
require('dotenv').config();
const request = require('supertest');
const app = require('../server');
const axios = require('axios');

const {
  SEA_NY_GRND_INPUT, SEA_NY_GRND_EXPECTED,
  SEA_NY_AIR_INPUT, SEA_NY_AIR_EXPECTED,
  NY_TKY_AIR_INPUT, NY_TKY_AIR_EXPECTED,
  BRLN_PRS_GRND_INPUT, BRLN_PRS_GRND_EXPECTED,
  BRLN_PRS_AIR_INPUT, BRLN_PRS_AIR_EXPECTED
} = require('./freight-test-sample');

jest.mock('axios');

describe('/api/freight Endpoint', () => {
  it('Test: Seattle -> New York (ground)', async () => {
    // Expected output
    axios.post.mockResolvedValue({
      data: SEA_NY_GRND_EXPECTED
    })
    const response = await request(app)
      .post('/api/freight')
      .send(SEA_NY_GRND_INPUT)
      .set('Content-Type', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(SEA_NY_GRND_EXPECTED);
  });

  it('Test: Seattle -> New York (air)', async () => {
    // Expected output
    axios.post.mockResolvedValue({
      data: SEA_NY_AIR_EXPECTED
    })
    const response = await request(app)
      .post('/api/freight')
      .send(SEA_NY_AIR_INPUT)
      .set('Content-Type', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(SEA_NY_AIR_EXPECTED);
  });

  it('Test: New York -> Tokyo (air)', async () => {
    // Expected output
    axios.post.mockResolvedValue({
      data: NY_TKY_AIR_EXPECTED
    })
    const response = await request(app)
      .post('/api/freight')
      .send(NY_TKY_AIR_INPUT)
      .set('Content-Type', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(NY_TKY_AIR_EXPECTED);
  });

  it('Test: Berlin -> Paris (ground)', async () => {
    // Expected output
    axios.post.mockResolvedValue({
      data: BRLN_PRS_GRND_EXPECTED
    })
    const response = await request(app)
      .post('/api/freight')
      .send(BRLN_PRS_GRND_INPUT)
      .set('Content-Type', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(BRLN_PRS_GRND_EXPECTED);
  });

  it('Test: Berlin -> Paris (air)', async () => {
    // Expected output
    axios.post.mockResolvedValue({
      data: BRLN_PRS_AIR_EXPECTED
    })
    const response = await request(app)
      .post('/api/freight')
      .send(BRLN_PRS_AIR_INPUT)
      .set('Content-Type', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(BRLN_PRS_AIR_EXPECTED);
  });
})